import { create } from 'zustand';
import type { Lang, Localized, RiskCheckResult } from '@pegasus/shared';
import { errorMessage, isApiError } from '../lib/http';
import { en, type Messages } from './en';
import { zh } from './zh';

export type { Messages };

export const LANG_KEY = 'pegasus.lang';

export const LANGS: readonly Lang[] = ['en', 'zh'];

/** Each language under its own name, for the switch. */
export const LANG_NAME: Record<Lang, string> = { en: 'EN', zh: '中文' };

const MESSAGES: Record<Lang, Messages> = { en, zh };

function isLang(v: string | null): v is Lang {
  return (LANGS as readonly (string | null)[]).includes(v);
}

export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStoredLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // storage unavailable (private mode etc.) – the choice still holds for this session
  }
}

/** The language the page starts in until the owner chooses one: Chinese for a Chinese browser, English otherwise. */
export function browserLang(): Lang {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/** Kept apart from the terminal store: the language is not part of a session and survives sign-out. */
export const useLangStore = create<LangState>()((set) => ({
  lang: readStoredLang() ?? browserLang(),
  setLang: (lang) => {
    writeStoredLang(lang);
    set({ lang });
  },
}));

export const useLang = (): Lang => useLangStore((s) => s.lang);

/** The dictionary of the page's language; the component re-renders when the language is switched. */
export const useT = (): Messages => MESSAGES[useLang()];

/** For code that runs outside a render (an effect, a callback of a query). */
export const currentT = (): Messages => MESSAGES[useLangStore.getState().lang];

/** A text in both languages, for what stays on screen across a switch of the language (a sticky notice, an error toast). */
export function inEveryLang(text: (t: Messages) => string): Localized {
  return { en: text(en), zh: text(zh) };
}

/** The label of a value the exchange or the server names in English; a value the table does not know is shown as it came. */
export function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return labels[value] ?? value;
}

/**
 * errorMessage in the page's language. The server words its errors in English: a code the dictionary
 * explains is shown with that explanation, and the server's own message stays next to it for the specifics.
 */
export function errorText(e: unknown, t: Messages): string {
  if (isApiError(e)) {
    const known = t.apiErrors[e.code];
    if (known !== undefined) return `${e.code}: ${known}（${e.message}）`;
  }
  return errorMessage(e);
}

/** A risk rejection in the page's language, built from its code and details; the server's message when the dictionary has none. */
export function riskText(result: Pick<RiskCheckResult, 'code' | 'message' | 'details'>, t: Messages): string {
  const say = t.riskReject[result.code];
  return say === undefined ? result.message : say(result.details ?? {}, result.message);
}

/** The risk engine's verdict carried by a RISK_REJECTED error (its details are the RiskCheckResult), in the page's language; null for any other error. */
export function rejectionText(e: unknown, t: Messages): string | null {
  if (!isApiError(e) || e.code !== 'RISK_REJECTED' || e.details === undefined) return null;
  const { code, message, details } = e.details;
  if (typeof message !== 'string') return null;
  const result: Pick<RiskCheckResult, 'code' | 'message' | 'details'> = { code: typeof code === 'string' ? code : '', message };
  if (typeof details === 'object' && details !== null) result.details = details as Record<string, string | number | boolean>;
  return riskText(result, t);
}
