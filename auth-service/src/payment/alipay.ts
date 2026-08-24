export interface AlipaySdkLike {
  pageExecute(
    method: "alipay.trade.page.pay",
    httpMethod: "GET",
    parameters: {
      readonly bizContent: Readonly<Record<string, string>>;
      readonly notifyUrl: string;
      readonly returnUrl: string;
    },
  ): string;
  checkNotifySignV2(parameters: Readonly<Record<string, unknown>>): boolean;
  exec(
    method: "alipay.trade.query" | "alipay.trade.close",
    parameters: {
      readonly bizContent: Readonly<Record<string, string>>;
      readonly notifyUrl?: string;
    },
    options: { readonly validateSign: true },
  ): Promise<unknown>;
}

export interface AlipayPagePayConfig {
  readonly notifyUrl: string;
  readonly returnUrl: string;
}

export type AlipayTradeStatus =
  | "WAIT_BUYER_PAY"
  | "TRADE_SUCCESS"
  | "TRADE_FINISHED"
  | "TRADE_CLOSED";

export interface AlipayTradeQueryResult {
  readonly recognized: boolean;
  readonly tradeStatus: string | null;
  readonly outTradeNo: string | null;
  readonly tradeNo: string | null;
  readonly totalAmount: string | null;
  readonly totalAmountFen: number | null;
  // 网关 code/sub_code 原样保留，供调用方精确识别 ACQ.TRADE_NOT_EXIST
  // 等特定子错误——不能只靠 recognized=false 笼统判断。
  readonly code: string | null;
  readonly subCode: string | null;
}

export interface AlipayTradeCloseResult {
  readonly code: string | null;
  readonly subCode: string | null;
}

const ALIPAY_PAGE_PAY_SUBJECT = "网络环境诊断与人工技术服务";
const ALIPAY_DATETIME_TIMEZONE = "Asia/Shanghai";

/* 支付宝 time_expire 要求 yyyy-MM-dd HH:mm:ss，按 Asia/Shanghai 本地时间。
   用 Intl.DateTimeFormat 取各字段后手动拼接，不依赖 locale 自身的分隔符/顺序。 */
export function formatAlipayDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ALIPAY_DATETIME_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const part = (type: string): string => {
    const found = parts.find((entry) => entry.type === type);
    if (found === undefined) {
      throw new Error("Alipay datetime formatting failed");
    }
    return found.value;
  };
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function formatFenAsYuan(amountFen: number): string {
  if (!Number.isSafeInteger(amountFen) || amountFen < 0) {
    throw new Error("Payment amount is invalid");
  }
  const yuan = Math.floor(amountFen / 100);
  const fen = amountFen % 100;
  return `${yuan}.${fen.toString().padStart(2, "0")}`;
}

export function parseYuanAsFen(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (match === null) {
    return null;
  }
  const yuanText = match[1];
  const fractionText = match[2] ?? "";
  if (yuanText === undefined) {
    return null;
  }
  const yuan = Number(yuanText);
  const fen = Number((fractionText + "00").slice(0, 2));
  const result = yuan * 100 + fen;
  return Number.isSafeInteger(result) ? result : null;
}

function readString(
  value: Record<string, unknown>,
  camelName: string,
  snakeName: string,
): string | null {
  const candidate = value[camelName] ?? value[snakeName];
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate
    : null;
}

export function createAlipayPagePayUrl(
  sdk: AlipaySdkLike,
  config: AlipayPagePayConfig,
  input: {
    readonly outTradeNo: string;
    readonly amountFen: number;
    readonly reservedUntil: Date;
  },
): string {
  let payUrl: unknown;
  try {
    payUrl = sdk.pageExecute("alipay.trade.page.pay", "GET", {
      bizContent: {
        outTradeNo: input.outTradeNo,
        productCode: "FAST_INSTANT_TRADE_PAY",
        totalAmount: formatFenAsYuan(input.amountFen),
        subject: ALIPAY_PAGE_PAY_SUBJECT,
        timeoutExpress: "30m",
        // 与 timeoutExpress 表达同一个 30 分钟窗口，但用绝对时刻，
        // 与本地 payments.reserved_until 精确对齐。
        timeExpire: formatAlipayDateTime(input.reservedUntil),
        qrPayMode: "4",
        qrcodeWidth: "220",
      },
      notifyUrl: config.notifyUrl,
      returnUrl: config.returnUrl,
    });
  } catch {
    // SDK 异常可能携带带签名的完整地址；不允许进入上层错误对象。
    throw new Error("Alipay page pay URL generation failed");
  }
  if (typeof payUrl !== "string" || payUrl.trim() === "") {
    throw new Error("Alipay page pay URL generation failed");
  }
  try {
    const parsed = new URL(payUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("not https");
    }
  } catch {
    throw new Error("Alipay page pay URL generation failed");
  }
  return payUrl;
}

export async function queryAlipayTrade(
  sdk: AlipaySdkLike,
  outTradeNo: string,
): Promise<AlipayTradeQueryResult> {
  const response = await sdk.exec("alipay.trade.query", {
    bizContent: { outTradeNo },
  }, { validateSign: true });
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return {
      recognized: false,
      tradeStatus: null,
      outTradeNo: null,
      tradeNo: null,
      totalAmount: null,
      totalAmountFen: null,
      code: null,
      subCode: null,
    };
  }

  const record = response as Record<string, unknown>;
  const code = readString(record, "code", "code");
  const subCode = readString(record, "subCode", "sub_code");
  const tradeStatus = readString(record, "tradeStatus", "trade_status");
  const returnedOutTradeNo = readString(record, "outTradeNo", "out_trade_no");
  const tradeNo = readString(record, "tradeNo", "trade_no");
  const totalAmount = readString(record, "totalAmount", "total_amount");
  const totalAmountFen = parseYuanAsFen(totalAmount);
  const recognized =
    code === "10000" &&
    (tradeStatus === "WAIT_BUYER_PAY" ||
      tradeStatus === "TRADE_SUCCESS" ||
      tradeStatus === "TRADE_FINISHED" ||
      tradeStatus === "TRADE_CLOSED");

  return {
    recognized,
    tradeStatus,
    outTradeNo: returnedOutTradeNo,
    tradeNo,
    totalAmount,
    totalAmountFen,
    code,
    subCode,
  };
}

const ALIPAY_TRADE_NOT_EXIST_SUB_CODE = "ACQ.TRADE_NOT_EXIST";

export function isTradeNotExist(result: AlipayTradeQueryResult): boolean {
  return result.code === "40004" && result.subCode === ALIPAY_TRADE_NOT_EXIST_SUB_CODE;
}

export async function closeAlipayTrade(
  sdk: AlipaySdkLike,
  outTradeNo: string,
): Promise<AlipayTradeCloseResult> {
  const response = await sdk.exec(
    "alipay.trade.close",
    { bizContent: { outTradeNo } },
    { validateSign: true },
  );
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return { code: null, subCode: null };
  }
  const record = response as Record<string, unknown>;
  return {
    code: readString(record, "code", "code"),
    subCode: readString(record, "subCode", "sub_code"),
  };
}
