import { from, race, timer, throwError, Subject, noop, Observable, Observer } from 'rxjs'
import { flatMap, bufferCount, take, filter, tap } from 'rxjs/operators'
import { rootInjector } from '@sigi/di'
import { ConstructorOf, Action, State } from '@sigi/types'
import { EffectModule, TERMINATE_ACTION, SSR_ACTION_META } from '@sigi/core'

import { SSRStateCacheInstance } from './ssr-states'
import { oneShotCache } from './ssr-oneshot-cache'
import { StateToPersist } from './state-to-persist'

export type ModuleMeta = ConstructorOf<EffectModule<any>>

const skipSymbol = Symbol('skip-symbol')

/**
 * Run all @SSREffect decorated effects of given modules and extract latest states.
 * `cleanup` function returned must be called before end of responding
 *
 * @param ctx request context, which will be passed to payloadGetter in SSREffect decorator param
 * @param modules used EffectModules
 * @param uuid the same uuid would reuse the same state which was created before
 * @param timeout seconds to wait before all effects stream out TERMINATE_ACTION
 * @returns EffectModule state
 */
export const runSSREffects = <Context, Returned = any>(
  ctx: Context,
  modules: ModuleMeta[],
  sharedCtx?: string | symbol,
  timeout = 3,
): Promise<StateToPersist<Returned>> => {
  const stateToSerialize: any = {}
  return modules.length === 0
    ? Promise.resolve(new StateToPersist(stateToSerialize))
    : race(
        from(modules).pipe(
          flatMap((constructor) => {
            return new Observable((observer: Observer<StateToPersist<Returned>>) => {
              let cleanup = noop
              const ssrActionsMeta = Reflect.getMetadata(SSR_ACTION_META, constructor.prototype) || []
              let effectModuleState: State<any>
              let moduleName: string
              const middleware = (effect$: Observable<Action<unknown>>) =>
                effect$.pipe(
                  tap({
                    error: (e) => {
                      observer.error(e)
                    },
                  }),
                )
              if (sharedCtx) {
                if (SSRStateCacheInstance.has(sharedCtx, constructor)) {
                  effectModuleState = SSRStateCacheInstance.get(sharedCtx, constructor)!
                  moduleName = constructor.prototype.moduleName
                } else {
                  const effectModuleInstance: EffectModule<unknown> = rootInjector.resolveAndInstantiate(constructor)
                  moduleName = effectModuleInstance.moduleName
                  effectModuleState = effectModuleInstance.createState(middleware)
                  SSRStateCacheInstance.set(sharedCtx, constructor, effectModuleState)
                }
              } else {
                const effectModuleInstance: EffectModule<unknown> = rootInjector.resolveAndInstantiate(constructor)
                moduleName = effectModuleInstance.moduleName
                effectModuleState = effectModuleInstance.createState(middleware)
                oneShotCache.store(ctx, constructor, effectModuleState)
              }
              let effectsCount = ssrActionsMeta.length
              let disposeFn = noop
              cleanup = sharedCtx
                ? () => disposeFn()
                : () => {
                    effectModuleState.unsubscribe()
                  }
              async function runEffects() {
                await Promise.all(
                  ssrActionsMeta.map(async (ssrActionMeta: any) => {
                    if (ssrActionMeta.payloadGetter) {
                      const payload = await ssrActionMeta.payloadGetter(ctx, skipSymbol)
                      if (payload !== skipSymbol) {
                        effectModuleState.dispatch({
                          type: ssrActionMeta.action,
                          payload,
                          state: effectModuleState,
                        })
                      } else {
                        effectsCount -= 1
                      }
                    } else {
                      effectModuleState.dispatch({
                        type: ssrActionMeta.action,
                        payload: undefined,
                        state: effectModuleState,
                      })
                    }
                  }),
                )

                if (effectsCount > 0) {
                  const action$ = new Subject<Action<unknown>>()
                  disposeFn = effectModuleState.subscribeAction((action) => {
                    action$.next(action)
                  })
                  await action$
                    .pipe(
                      filter((act) => act.type === TERMINATE_ACTION.type),
                      bufferCount(effectsCount),
                      take(1),
                    )
                    .toPromise()

                  const state = effectModuleState.getState()
                  stateToSerialize[moduleName] = state
                }
              }
              runEffects()
                .then(() => {
                  observer.next(new StateToPersist(stateToSerialize))
                  observer.complete()
                })
                .catch((e) => {
                  observer.error(e)
                })
              return cleanup
            })
          }),
        ),
        timer(timeout * 1000).pipe(flatMap(() => throwError(new Error('Terminate timeout')))),
      ).toPromise()
}
