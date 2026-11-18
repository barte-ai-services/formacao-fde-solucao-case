// #293 Tipo mínimo do node:async_hooks que o middleware do id de correlação usa; o tsconfig só traz os do Worker.
// No Worker, a flag `nodejs_als` do wrangler.jsonc entrega este módulo.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
