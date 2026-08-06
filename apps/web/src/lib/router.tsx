import {
  createContext,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

type LocationState = {
  pathname: string
  search: string
}

type RouterContextValue = LocationState & {
  navigate: (to: string, replace?: boolean) => void
}

const RouterContext = createContext<RouterContextValue | null>(null)

function readLocation(): LocationState {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  }
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(readLocation)

  useEffect(() => {
    const handlePopState = () => setLocation(readLocation())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const navigate = useCallback((to: string, replace = false) => {
    const target = new URL(to, window.location.href)
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href)
      return
    }
    const next = `${target.pathname}${target.search}${target.hash}`
    if (replace) window.history.replaceState(null, '', next)
    else window.history.pushState(null, '', next)
    setLocation(readLocation())
  }, [])

  const value = useMemo(
    () => ({ ...location, navigate }),
    [location, navigate],
  )
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useLocation(): RouterContextValue {
  const context = useContext(RouterContext)
  if (!context) throw new Error('useLocation must be used inside Router')
  return context
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string
}

export function Link({ to, onClick, ...props }: LinkProps) {
  const { navigate } = useLocation()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.target === '_blank' ||
      props.download
    ) {
      return
    }
    event.preventDefault()
    navigate(to)
  }
  return <a {...props} href={to} onClick={handleClick} />
}

type NavLinkProps = LinkProps & {
  end?: boolean
}

export function NavLink({ className, end = false, to, ...props }: NavLinkProps) {
  const { pathname } = useLocation()
  const targetPath = new URL(to, window.location.href).pathname
  const active =
    pathname === targetPath ||
    (!end && targetPath !== '/' && pathname.startsWith(`${targetPath}/`))
  const resolvedClassName = [className, active ? 'active' : null]
    .filter(Boolean)
    .join(' ')
  return (
    <Link
      {...props}
      to={to}
      className={resolvedClassName}
      aria-current={active ? 'page' : props['aria-current']}
    />
  )
}

/**
 * A `URLSearchParams` replaces the query string outright; a record patches it,
 * setting each named key and deleting the ones given as `null`.
 *
 * The patch form is the one callers usually want. A shared link carries more
 * than the parameter being changed — the Live map's `view=` viewport and the
 * sender's filters ride in the same query string — and replacing wholesale
 * silently threw those away the first time the reader clicked an aircraft.
 */
type SearchParamsInput =
  | URLSearchParams
  | Record<string, string | null>

export function useSearchParams(): [
  URLSearchParams,
  (next: SearchParamsInput, replace?: boolean) => void,
] {
  const { pathname, search, navigate } = useLocation()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const setParams = useCallback(
    (next: SearchParamsInput, replace = false) => {
      let nextParams: URLSearchParams
      if (next instanceof URLSearchParams) {
        nextParams = new URLSearchParams()
        next.forEach((value, key) => nextParams.append(key, value))
      } else {
        nextParams = new URLSearchParams(search)
        for (const [key, value] of Object.entries(next)) {
          if (value === null) nextParams.delete(key)
          else nextParams.set(key, value)
        }
      }
      const query = nextParams.toString()
      navigate(`${pathname}${query ? `?${query}` : ''}`, replace)
    },
    [navigate, pathname, search],
  )
  return [params, setParams]
}
