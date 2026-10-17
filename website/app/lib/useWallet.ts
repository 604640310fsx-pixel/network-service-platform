import { useEffect, useState } from "react";
import { getMyWalletSnapshot, refreshMyWallet, subscribeMyWallet, type WalletLoad } from "./wallet-api";

/* 所有 useMyWallet 实例共享 wallet-api 的同一份服务端快照订阅：
   任一 retry 只触发一次服务端重读并广播给全部订阅者——服务端永远是唯一事实。
   加载中、失败、未登录各自是独立状态，调用方据此显示占位或重试，
   绝不把它们显示成 ¥0.00；只有服务端真实返回 balanceFen=0 时才是零余额。 */
export function useMyWallet(reloadToken = 0): { readonly state: WalletLoad; readonly retry: () => void } {
  const [state, setState] = useState<WalletLoad>(getMyWalletSnapshot());
  const [localToken, setLocalToken] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeMyWallet(() => setState(getMyWalletSnapshot()));
    void refreshMyWallet();
    return unsubscribe;
  }, [reloadToken, localToken]);

  return { state, retry: () => setLocalToken((token) => token + 1) };
}
