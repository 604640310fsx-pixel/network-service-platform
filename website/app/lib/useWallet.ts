import { useEffect, useState } from "react";
import { WalletApiError, getMyWallet, type WalletLoad } from "./wallet-api";

/* 读取 GET /api/me/wallet。加载中、失败、未登录各自是独立状态，调用方据此显示占位或重试，
   绝不把它们显示成 ¥0.00；只有服务端真实返回 balanceFen=0 时才是零余额。 */
export function useMyWallet(reloadToken = 0): { readonly state: WalletLoad; readonly retry: () => void } {
  const [state, setState] = useState<WalletLoad>({ kind: "loading" });
  const [localToken, setLocalToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyWallet(controller.signal)
      .then((wallet) => {
        if (!stopped) setState({ kind: "ready", wallet });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof WalletApiError && error.code === "unauthorized") setState({ kind: "unauthorized" });
        else setState({ kind: "error", code: error instanceof WalletApiError ? error.code : "wallet_unavailable" });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken, localToken]);

  return { state, retry: () => setLocalToken((token) => token + 1) };
}
