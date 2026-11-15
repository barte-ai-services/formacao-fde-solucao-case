/** Casa um caminho com um padrão como `/pagar/fila/:id`. Cada `:nome` vira um parâmetro. */
export type RouteParams = Record<string, string>;

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Os parâmetros, se `pathname` casa com `pattern`; `null` se não casa. A barra no fim é ignorada. */
export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const expected = segments(pattern);
  const actual = segments(pathname);
  if (expected.length !== actual.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const got = actual[i]!;
    if (want.startsWith(":")) {
      const value = decode(got);
      if (value === null || value.length === 0) return null;
      params[want.slice(1)] = value;
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

/** A primeira rota que casa, na ordem da lista, com os parâmetros dela. */
export function matchRoute<R extends { path: string }>(
  routes: readonly R[],
  pathname: string,
): { route: R; params: RouteParams } | null {
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}
