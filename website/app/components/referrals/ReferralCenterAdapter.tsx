import { useEffect, useState } from "react";

import {
  adaptReferralState,
  getReferralState,
  type ReferralAdapterState,
  type ReferralStateResponse,
} from "../../lib/referral-api";
import { ReferralCenter, type ReferralCenterNotice } from "./ReferralCenter";
import type { ClipboardWriter } from "./referralModel";

export type ReferralStateLoader = (
  signal: AbortSignal,
) => Promise<ReferralStateResponse>;

export type ReferralCenterAdapterProps = {
  readonly loadState?: ReferralStateLoader;
  readonly clipboard?: ClipboardWriter | null;
  readonly notice?: ReferralCenterNotice;
};

export function ReferralCenterAdapter({
  loadState = getReferralState,
  clipboard,
  notice = "pending",
}: ReferralCenterAdapterProps) {
  const [requestState, setRequestState] = useState<ReferralAdapterState>({
    status: "pending",
  });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setRequestState({ status: "loading" });
    void loadState(controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) {
          setRequestState({ status: "ready", response });
        }
      },
      (error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setRequestState({ status: "error" });
        }
      },
    );
    return () => controller.abort();
  }, [loadState, retry]);

  const component = adaptReferralState(requestState);
  return (
    <ReferralCenter
      data={component.data}
      link={component.link}
      clipboard={clipboard}
      notice={notice}
      onRetry={
        requestState.status === "error"
          ? () => setRetry((value) => value + 1)
          : undefined
      }
    />
  );
}
