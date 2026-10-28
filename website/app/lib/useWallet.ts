import { useEffect, useReducer, useState } from "react";
import { useAuth } from "./auth";
import { getMyWalletSnapshotFor, refreshMyWallet, subscribeMyWallet, type WalletLoad } from "./wallet-api";

/* 所有 useMyWallet 实例共享 wallet-api 的同一份服务端快照订阅，快照按当前会话
   身份分栏：渲染期经 getMyWalletSnapshotFor 读取——登出/换号的首屏也只会看到
   loading，绝不先闪出旧账号余额；任一 retry 只触发一次服务端重读并广播给全部
   订阅者——服务端永远是唯一事实。加载中、失败、未登录各自是独立状态，调用方据此
   显示占位或重试，绝不把它们显示成 ¥0.00。 */
export function useMyWallet(reloadToken = 0): { readonly state: WalletLoad; readonly retry: () => void } {
  const { status, principal } = useAuth();
  const walletOwner = status === "authenticated" && principal !== null ? `user:${principal.email}` : "anonymous";
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [localToken, setLocalToken] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeMyWallet(bump);
    void refreshMyWallet(walletOwner);
    return unsubscribe;
  }, [reloadToken, localToken, walletOwner]);

  return { state: getMyWalletSnapshotFor(walletOwner), retry: () => setLocalToken((token) => token + 1) };
}
