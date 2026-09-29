import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LoginRequestError, type LoginFailureCode } from "./auth-errors";

export type AuthPrincipal = {
  readonly email: string;
  readonly role: "user" | "admin";
};

type AuthSession = {
  readonly principal: AuthPrincipal;
  readonly csrfToken: string;
};

export type AuthStatus = "checking" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  readonly status: AuthStatus;
  readonly principal: AuthPrincipal | null;
  readonly csrfToken: string | null;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /** Re-reads GET /api/auth/me, e.g. after the account's login email changed. */
  readonly refresh: () => Promise<void>;
};

type AuthState = {
  readonly status: AuthStatus;
  readonly session: AuthSession | null;
};

type LogoutFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

type ErrorResponse = {
  readonly error: { readonly code: string };
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }

  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}

function isLoginSuccess(value: unknown): value is { readonly status: "ok" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok"
  );
}

function isExactLogoutSuccess(
  value: unknown,
): value is { readonly status: "ok" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "status" &&
    "status" in value &&
    value.status === "ok"
  );
}

function isAuthSession(value: unknown): value is {
  readonly user: AuthPrincipal;
  readonly csrfToken: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("user" in value) ||
    !("csrfToken" in value)
  ) {
    return false;
  }

  const user = value.user;
  return (
    typeof user === "object" &&
    user !== null &&
    "email" in user &&
    typeof user.email === "string" &&
    "role" in user &&
    (user.role === "user" || user.role === "admin") &&
    typeof value.csrfToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestSession(signal?: AbortSignal): Promise<AuthSession | null> {
  const response = await fetch("/api/auth/me", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });

  if (response.status === 401) {
    return null;
  }

  const body = await readJson(response);
  if (!response.ok || !isAuthSession(body)) {
    throw new Error("Auth session is unavailable");
  }

  return {
    principal: body.user,
    csrfToken: body.csrfToken,
  };
}

export async function requestCurrentWebSessionLogout(
  csrfToken: string,
  fetchOperation: LogoutFetch = fetch,
): Promise<void> {
  const response = await fetchOperation("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: "{}",
  });
  const body = await readJson(response);
  if (response.status !== 200 || !isExactLogoutSuccess(body)) {
    throw new Error("Logout request failed");
  }
}

function mapLoginFailure(status: number, body: unknown): LoginFailureCode {
  const code = isErrorResponse(body) ? body.error.code : null;

  if (status === 401 && code === "invalid_credentials") {
    return "invalid_credentials";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 503 && code === "busy") {
    return "busy";
  }
  if (status === 503 && code === "auth_unavailable") {
    return "auth_unavailable";
  }
  return "login_failed";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    status: "checking",
    session: null,
  });
  const logoutPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void requestSession(controller.signal)
      .then((currentSession) => {
        setAuthState({
          status: currentSession === null ? "unauthenticated" : "authenticated",
          session: currentSession,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setAuthState({ status: "unauthenticated", session: null });
      });

    return () => controller.abort();
  }, []);

  async function login(email: string, password: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new LoginRequestError("auth_unavailable");
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new LoginRequestError(mapLoginFailure(response.status, body));
    }
    if (!isLoginSuccess(body)) {
      throw new LoginRequestError("login_failed");
    }

    try {
      const authenticatedSession = await requestSession();
      if (authenticatedSession === null) {
        throw new Error("Session cookie was not accepted");
      }
      setAuthState({ status: "authenticated", session: authenticatedSession });
    } catch {
      setAuthState({ status: "unauthenticated", session: null });
      throw new LoginRequestError("auth_unavailable");
    }
  }

  async function refresh(): Promise<void> {
    try {
      const currentSession = await requestSession();
      setAuthState({
        status: currentSession === null ? "unauthenticated" : "authenticated",
        session: currentSession,
      });
    } catch {
      // Keep the current state; a failed re-read is not a sign-out.
    }
  }

  function logout(): Promise<void> {
    if (logoutPromiseRef.current !== null) {
      return logoutPromiseRef.current;
    }
    if (authState.status !== "authenticated" || authState.session === null) {
      return Promise.reject(new Error("No authenticated Session"));
    }

    const operation = requestCurrentWebSessionLogout(
      authState.session.csrfToken,
    ).then(() => {
      setAuthState({ status: "unauthenticated", session: null });
    });
    logoutPromiseRef.current = operation;
    void operation.then(
      () => {
        if (logoutPromiseRef.current === operation) {
          logoutPromiseRef.current = null;
        }
      },
      () => {
        if (logoutPromiseRef.current === operation) {
          logoutPromiseRef.current = null;
        }
      },
    );
    return operation;
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status: authState.status,
      principal: authState.session?.principal ?? null,
      csrfToken: authState.session?.csrfToken ?? null,
      login,
      logout,
      refresh,
    }),
    [authState],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}
