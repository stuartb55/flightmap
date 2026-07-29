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

type SearchParamsInput =
  | URLSearchParams
  | Record<string, string>

export function useSearchParams(): [
  URLSearchParams,
  (next: SearchParamsInput, replace?: boolean) => void,
] {
  const { pathname, search, navigate } = useLocation()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const setParams = useCallback(
    (next: SearchParamsInput, replace = false) => {
      const nextParams = new URLSearchParams()
      if (next instanceof URLSearchParams) {
        next.forEach((value, key) => nextParams.append(key, value))
      } else {
        Object.entries(next).forEach(([key, value]) => nextParams.set(key, value))
      }
      const query = nextParams.toString()
      navigate(`${pathname}${query ? `?${query}` : ''}`, replace)
    },
    [navigate, pathname],
  )
  return [params, setParams]
}
