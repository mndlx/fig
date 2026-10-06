import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toAccountMain, type AdoptionPreview, type AdoptionSide } from './adoption'
import { ADOPT_MERGED, ADOPT_TOAST, noteForNextPage as remember } from './adoptionNotes'
import { authEnabled, currentUser, isLocalOnly, localModeAllowed } from './auth'
import { exportJson } from './backup'
import { db } from './db'
import { dateFmt, decimalSep, t } from './i18n'
import { IconFig } from './icons'
import { fetchRate, formatMoney } from './money'
import { cancelAdoption, getSyncStatus, previewAdoption, resolveAdoption, syncNow } from './sync'

type Choice = 'merge' | 'account' | 'leave'

/** Numero di un cambio da mostrare nel campo: poche cifre, col separatore della lingua. */
const rateText = (value: number) => String(Number(value.toPrecision(6))).replace('.', decimalSep())
const rateValue = (text: string) => Number(text.trim().replace(',', '.'))

/**
 * Primo accesso da un dispositivo che ha già dati suoi (usato senza account) a un account che ne ha altri.
 * Finché la persona non sceglie non è stato toccato niente, né qui né nell'account:
 * può aggiungere i dati di qui all'account, tenere solo quelli dell'account, uscire, o decidere dopo.
 */
export function AdoptionChoice({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<AdoptionPreview | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [step, setStep] = useState<'choose' | 'drop'>('choose')
  const [busy, setBusy] = useState<Choice | null>(null)
  const [error, setError] = useState('')
  const [localMode, setLocalMode] = useState(false)
  const [backup, setBackup] = useState<{ file?: string; failed?: boolean }>({})
  // Il cambio si scrive nel verso più naturale; `forward` = "1 valuta di qui = ? valuta dell'account".
  const [rate, setRate] = useState('')
  const [forward, setForward] = useState(true)
  const rateTouched = useRef(false)
  const busyRef = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const dropRef = useRef<HTMLHeadingElement>(null)
  const groupRef = useRef<HTMLFieldSetElement>(null)

  const device = preview?.device
  const account = preview?.account
  const gap = !!device && !!account && device.currency.code !== account.currency.code

  useEffect(() => {
    titleRef.current?.focus()
    void localModeAllowed().then(setLocalMode)
    let cancelled = false
    void previewAdoption().then((p) => {
      if (cancelled) return
      // Niente da scegliere (risposta già data altrove): si torna all'app.
      if (!p) return onClose()
      setPreview(p)
      if (p.device.currency.code === p.account.currency.code) return
      // Verso del campo: quello in cui la risposta è un numero "normale" (1 EUR = 98 L, non 1 L = 0,0102 EUR).
      const propose = (x: number) => {
        if (cancelled || rateTouched.current) return
        setForward(x >= 1)
        setRate(rateText(x >= 1 ? x : 1 / x))
      }
      setForward(p.account.currency.decimals <= p.device.currency.decimals)
      if (p.rateHint) propose(p.rateHint)
      void fetchRate(p.device.currency.code, p.account.currency.code, new Date()).then((x) => x && x > 0 && propose(x))
    })
    return () => {
      cancelled = true
    }
    // Solo all'apertura: i dati a schermo sono un'anteprima, quelli veri si rileggono al momento della scelta.
  }, [])

  // Un'altra finestra ha già risposto (o il dispositivo ha lasciato l'account): questa domanda non vale più.
  const pending = useLiveQuery(() => db.syncMeta.get('adopt').then((row) => !!row), [], true)
  useEffect(() => {
    if (pending || busyRef.current) return
    void syncNow()
    onClose()
  }, [pending, onClose])

  useEffect(() => {
    // Alla conferma il fuoco va sulla domanda; tornando indietro, sull'opzione che era stata scelta.
    if (step === 'drop') dropRef.current?.focus()
    else groupRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [step])

  const typed = rateValue(rate)
  const validRate = Number.isFinite(typed) && typed > 0
  /** Il cambio come lo vuole l'unione: 1 unità della valuta di qui = x unità di quella dell'account. */
  const x = validRate ? (forward ? typed : 1 / typed) : NaN

  function start(kind: Choice) {
    busyRef.current = true
    setBusy(kind)
    setError('')
  }
  function fail(message: string) {
    busyRef.current = false
    setBusy(null)
    setError(message)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !preview) return
    if (!choice) {
      setError(t('adopt.errChoose'))
      groupRef.current?.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    if (choice === 'account') {
      setError('')
      return setStep('drop')
    }
    if (choice === 'leave') {
      start('leave')
      try {
        const url = await cancelAdoption()
        if (!url) return onClose()
        // Il messaggio segue quello che è successo davvero: si continua senza account solo se lo scollegamento lo ha deciso.
        if (isLocalOnly()) remember(ADOPT_TOAST, 'adopt.toastLeave')
        location.href = url
      } catch {
        fail(t('adopt.errLeave'))
      }
      return
    }
    if (gap && !validRate) {
      setError(t('mainCur.rateErr'))
      document.getElementById('adopt-rate')?.focus()
      return
    }
    start('merge')
    try {
      const outcome = await resolveAdoption('merge', gap ? x : undefined)
      if (outcome === 'merged') {
        // "Ora sono nel tuo account" è vero solo se il caricamento è già riuscito.
        const s = getSyncStatus()
        remember(ADOPT_TOAST, s.pending === 0 && s.state === 'idle' ? 'adopt.toastMerge' : 'adopt.toastMergeLater')
        remember(ADOPT_MERGED, JSON.stringify(gap ? { cur: account!.currency.code } : {}))
      }
      onClose()
    } catch {
      fail(t('adopt.error'))
    }
  }

  async function drop() {
    if (busy) return
    start('account')
    try {
      const outcome = await resolveAdoption('account')
      if (outcome !== 'dropped') return onClose()
      remember(ADOPT_TOAST, 'adopt.toastAccount')
      // Il dispositivo è vuoto: riparte come uno nuovo e scarica i dati dell'account.
      location.reload()
    } catch {
      fail(t('adopt.error'))
    }
  }

  async function downloadBackup() {
    try {
      setBackup({ file: await exportJson() })
    } catch {
      setBackup({ failed: true })
    }
  }

  /** Cifra mostrata dopo l'ultimo scambio di verso e quella che c'era prima: tornando indietro si ritrova quella scritta. */
  const swapped = useRef<{ shown: string; back: string } | null>(null)
  function swap() {
    rateTouched.current = true
    if (validRate) {
      const next = swapped.current?.shown === rate ? swapped.current.back : rateText(1 / typed)
      swapped.current = { shown: next, back: rate }
      setRate(next)
    }
    setForward((v) => !v)
  }

  const day = dateFmt({ day: 'numeric', month: 'short', year: 'numeric' })
  const summary = (side: AdoptionSide, title: string, onlyHere?: number) => (
    <section className="card adopt-side">
      <h2>{title}</h2>
      <p>{t('adopt.sumCounts', { tx: side.transactions, goals: side.goals, rec: side.recurring })}</p>
      {side.openings > 0 && <p>{t('adopt.sumStart', { n: side.openings })}</p>}
      <p className="muted">{side.first !== null && side.last !== null ? t('adopt.sumDates', { from: day.format(side.first), to: day.format(side.last) }) : t('adopt.sumNoDates')}</p>
      {onlyHere !== undefined && <p className="adopt-here">{t('adopt.sumOnlyHere', { n: onlyHere })}</p>}
    </section>
  )

  const who = currentUser()?.email ?? currentUser()?.name
  const canLeave = authEnabled()
  const cta = choice === 'merge' ? t('adopt.mergeCta') : choice === 'leave' ? t(localMode ? 'adopt.leaveCta' : 'adopt.signOutCta') : t('adopt.accountCta')
  const busyText = busy === 'merge' ? t('adopt.busyMerge') : busy === 'account' ? t('adopt.busyAccount') : busy === 'leave' ? t('adopt.busyLeave') : ''
  const money = (minor: number, code: string) => formatMoney(minor, preview?.currencies.find((c) => c.code === code) ?? { code, symbol: code, decimals: 2 })
  const from = forward ? device?.currency.code : account?.currency.code
  const to = forward ? account?.currency.code : device?.currency.code

  const option = (value: Choice, label: string, hint: string) => (
    <label className={`adopt-option${choice === value ? ' on' : ''}`}>
      <input
        type="radio"
        name="adopt-choice"
        checked={choice === value}
        aria-labelledby={`adopt-${value}-label`}
        aria-describedby={`adopt-${value}-hint`}
        onChange={() => {
          setChoice(value)
          setError('')
        }}
      />
      <span>
        <span id={`adopt-${value}-label`} className="adopt-option-label">
          {label}
        </span>
        <span id={`adopt-${value}-hint`} className="muted small">
          {hint}
        </span>
      </span>
    </label>
  )

  const backupBlock = (
    <div className="adopt-backup">
      <button type="button" className="secondary wide" disabled={!!busy} onClick={() => void downloadBackup()}>
        {t('adopt.backup')}
      </button>
      {backup.file && (
        <p className="small" role="status">
          {t('adopt.backupDone', { file: backup.file })}
        </p>
      )}
      {backup.failed && (
        <p className="error" role="alert">
          {t('adopt.backupErr')}
        </p>
      )}
      <p className="muted small">{t('adopt.backupNote')}</p>
    </div>
  )

  return (
    <main className="adopt" aria-busy={!!busy}>
      <span className="wordmark" aria-hidden="true">
        <IconFig />
        fig
      </span>
      <h1 ref={titleRef} tabIndex={-1}>
        {t('adopt.title')}
      </h1>
      <p>{t('adopt.intro')}</p>
      {who && <p className="muted small">{t('adopt.who', { name: who })}</p>}

      {!preview || !device || !account ? (
        <p className="muted" role="status">
          {t('adopt.loading')}
        </p>
      ) : step === 'drop' ? (
        <section className="adopt-drop">
          <h2 ref={dropRef} tabIndex={-1}>
            {t('adopt.dropTitle')}
          </h2>
          <p>
            {t('adopt.sumCounts', { tx: device.transactions, goals: device.goals, rec: device.recurring })}
            {device.openings > 0 && ` · ${t('adopt.sumStart', { n: device.openings })}`}
          </p>
          <p>{t('adopt.dropBody')}</p>
          <p className="muted small">{t('adopt.dropKeep')}</p>
          {backupBlock}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {busyText && (
            <p className="muted small" role="status">
              {busyText}
            </p>
          )}
          <button
            type="button"
            className="secondary wide"
            disabled={!!busy}
            onClick={() => {
              setStep('choose')
              setError('')
            }}
          >
            {t('common.back')}
          </button>
          <button type="button" className="danger wide" disabled={!!busy} onClick={() => void drop()}>
            {t('adopt.dropConfirm')}
          </button>
        </section>
      ) : (
        <>
          {summary(device, t('adopt.sumDevice', { code: device.currency.code }), preview.onlyHere)}
          {summary(account, t('adopt.sumAccount', { code: account.currency.code }))}

          <form onSubmit={submit} noValidate>
            <fieldset className="adopt-options" ref={groupRef} disabled={!!busy}>
              <legend>{t('adopt.question')}</legend>
              {option('merge', t('adopt.merge'), t('adopt.mergeHint'))}
              {choice === 'merge' && (
                <div className="adopt-detail">
                  <p>{t('adopt.mergeDetail')}</p>
                  {preview.droppedOpenings.map((o) => (
                    <p key={o.accountId}>{t('adopt.mergeOpening', { name: o.name, here: money(o.here, o.currency), there: money(o.there, o.currency) })}</p>
                  ))}
                  {preview.rekeyed.map((r) => (
                    <p key={r.id}>{t('adopt.mergeAccount', { name: r.name, here: r.here, there: r.there, newName: r.newName })}</p>
                  ))}
                  {gap && (
                    <div className="adopt-rate">
                      <p>{t('adopt.rateWhy', { device: device.currency.code, account: account.currency.code })}</p>
                      <label className="field" htmlFor="adopt-rate">
                        {t('adopt.rate', { from: from!, to: to! })}
                      </label>
                      <input
                        id="adopt-rate"
                        className="input"
                        inputMode="decimal"
                        autoComplete="off"
                        value={rate}
                        aria-invalid={!!error && !validRate}
                        aria-describedby="adopt-rate-help adopt-rate-preview"
                        onChange={(e) => {
                          rateTouched.current = true
                          setRate(e.target.value)
                          setError('')
                        }}
                      />
                      <button type="button" className="link-btn" onClick={swap}>
                        {t('adopt.rateSwap', { from: to!, to: from! })}
                      </button>
                      <p id="adopt-rate-preview" className="adopt-rate-preview" aria-live="polite">
                        {validRate && (
                          <>
                            {t('adopt.ratePreview', {
                              here: formatMoney(preview.available, device.currency),
                              there: formatMoney(toAccountMain(preview.available, device.currency.decimals, account.currency.decimals, x), account.currency),
                            })}{' '}
                            <span className="muted">{t('adopt.rateCheck')}</span>
                          </>
                        )}
                      </p>
                      <p id="adopt-rate-help" className="muted small">
                        {t('adopt.rateHelp', { device: device.currency.code, account: account.currency.code })}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {option('account', t('adopt.account'), t('adopt.accountHint'))}
              {canLeave && option('leave', t(localMode ? 'adopt.leave' : 'adopt.signOut'), t(localMode ? 'adopt.leaveHint' : 'adopt.signOutHint'))}
            </fieldset>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {busyText && (
              <p className="muted small" role="status">
                {busyText}
              </p>
            )}
            <button type="submit" className="primary wide" disabled={!!busy}>
              {cta}
            </button>
          </form>

          <div className="adopt-later">
            <button type="button" className="link-btn" disabled={!!busy} onClick={onClose}>
              {t('adopt.later')}
            </button>
            <p className="muted small">{t('adopt.laterHint')}</p>
          </div>
          {backupBlock}
        </>
      )}
    </main>
  )
}
