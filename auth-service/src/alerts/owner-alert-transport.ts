import type { OwnerAlertReason } from "./owner-alert-runtime.js";

/* Transport boundary for owner alerts — TEST_ONLY. The synthetic transport
   below is the only implementation wired here: no real HTTP/mail/socket
   send, no real recipient, no provider side effects. A future real transport
   is a separately authorized thin adapter over the shared mail plumbing. */

export interface OwnerAlertDelivery {
  readonly idempotencyKey: string;
  readonly eventKey: string;
  readonly caseRef: string;
  readonly reason: OwnerAlertReason;
  readonly episode: number;
  readonly reminderOrdinal: number;
  readonly anchorAt: string;
  readonly dueAt: string;
  readonly recipientRef: string;
  readonly recipient: string;
}

/* accepted = transport accepted the item (never delivered/read);
   failed = transport refused outright; unknown = result could not be learned
   (timeout/network ambiguity) — retried under the same event key with no
   dedup or delivery guarantee. */
export type OwnerAlertSendOutcome = "ACCEPTED" | "FAILED" | "UNKNOWN";

export interface OwnerAlertTransport {
  send(delivery: OwnerAlertDelivery): Promise<OwnerAlertSendOutcome>;
}

type ScriptedOutcome =
  OwnerAlertSendOutcome | Error | ((delivery: OwnerAlertDelivery) => OwnerAlertSendOutcome | Promise<OwnerAlertSendOutcome>);

/* Scripted synthetic transport for tests: consumes one scripted outcome per
   call (default ACCEPTED when the script is exhausted), records every
   delivery it was asked to send. A thrown Error or 'UNKNOWN' models a send
   whose result was never learned. */
export class SyntheticOwnerAlertTransport implements OwnerAlertTransport {
  readonly calls: OwnerAlertDelivery[] = [];
  private readonly script: readonly ScriptedOutcome[];
  private index = 0;

  constructor(script: readonly ScriptedOutcome[] = []) {
    this.script = script;
  }

  async send(delivery: OwnerAlertDelivery): Promise<OwnerAlertSendOutcome> {
    this.calls.push(delivery);
    const step = this.script[this.index] ?? "ACCEPTED";
    this.index += 1;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(delivery);
    return step;
  }
}
