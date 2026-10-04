import { LANGS, LANG_NAME, useLangStore } from '../i18n';

/** English / 中文. The choice is kept in localStorage and applies to the whole page at once. */
export function LangSwitch() {
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  return (
    <span className="btn-group lang-switch" role="group" aria-label="Language / 语言">
      {LANGS.map((l) => (
        <button key={l} type="button" className={`btn btn-sm${l === lang ? ' active' : ''}`} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {LANG_NAME[l]}
        </button>
      ))}
    </span>
  );
}
