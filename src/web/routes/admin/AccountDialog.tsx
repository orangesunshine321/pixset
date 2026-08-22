import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { api, ApiError } from "../../lib/api.ts";

interface Me {
  email: string;
  twoFactorEnabled: boolean;
  backupCodesRemaining: number;
  webhookUrl: string | null;
}

export function AccountDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  // While the one-time 2FA backup codes are on screen, dismissing the dialog
  // would discard them forever (there's no re-view/regenerate endpoint). Hold
  // the dialog open until the operator acknowledges saving them, so an accidental
  // backdrop-click or Escape can't lose them.
  const [held, setHeld] = useState(false);

  const closeGuarded = useCallback(() => {
    if (held) return;
    onClose();
  }, [held, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeGuarded();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeGuarded]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4"
      onClick={closeGuarded}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line-strong bg-surface-2 p-6 shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-1">Account settings</h2>
            <p className="mt-0.5 truncate text-sm text-text-3">{email}</p>
          </div>
          {!held && (
            <button
              onClick={closeGuarded}
              aria-label="Close"
              className="tap-target -mr-2 -mt-2 flex items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        <ChangePasswordForm />
        <div className="my-6 border-t border-line" />
        <PasskeysSection />
        <div className="my-6 border-t border-line" />
        <TwoFactorSection
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["admin-me"] })}
          onHoldChange={setHeld}
        />
        <div className="my-6 border-t border-line" />
        <WebhookSection
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["admin-me"] })}
        />
        <div className="my-6 border-t border-line" />
        <ChangeEmailForm
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["admin-me"] })}
        />
      </div>
    </div>
  );
}

interface PasskeyItem {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

function PasskeysSection() {
  const queryClient = useQueryClient();
  const supported = browserSupportsWebAuthn();
  const list = useQuery({
    queryKey: ["admin-passkeys"],
    queryFn: () => api.get<{ passkeys: PasskeyItem[] }>("/api/admin/account/passkeys"),
  });
  const passkeys = list.data?.passkeys ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-passkeys"] });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-text-1">Passkeys</h3>
        <p className="mt-0.5 text-xs text-text-3">
          Sign in with Touch ID, Face ID, or a security key — one tap, no password, no
          authenticator code. Your password keeps working as a fallback.
        </p>
      </div>
      {passkeys.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-canvas">
          {passkeys.map((pk) => (
            <PasskeyRow key={pk.id} passkey={pk} onChanged={refresh} />
          ))}
        </ul>
      )}
      {supported ? (
        <AddPasskey onAdded={refresh} />
      ) : (
        <p className="text-xs text-text-3">This browser doesn't support passkeys.</p>
      )}
    </div>
  );
}

function PasskeyRow({ passkey, onChanged }: { passkey: PasskeyItem; onChanged: () => void }) {
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.delete(`/api/admin/account/passkeys/${encodeURIComponent(passkey.id)}`, { password });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already removed from another tab/device — refreshing the list is the
        // success outcome; "try again" could never work.
        onChanged();
      } else if (err instanceof ApiError && err.message === "wrong_password") {
        setError("Password is incorrect.");
      } else {
        setError("Couldn't remove the passkey. Try again.");
      }
    } finally {
      // On success the refetch unmounts this row; if that refetch fails the
      // row must not be left stuck on a disabled "Removing…" button.
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-text-1">{passkey.name}</p>
          <p className="text-xs text-text-3">
            Added {new Date(passkey.createdAt).toLocaleDateString()}
            {passkey.lastUsedAt
              ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
              : " · never used"}
          </p>
        </div>
        <button
          onClick={() => {
            setRemoving((v) => !v);
            setError(null);
            setPassword("");
          }}
          className="shrink-0 text-xs font-medium text-text-2 underline decoration-line-strong underline-offset-2 hover:text-text-1"
        >
          {removing ? "Cancel" : "Remove"}
        </button>
      </div>
      {removing && (
        <form onSubmit={remove} className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Confirm with your password"
            autoComplete="current-password"
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-text-1 outline-none transition-colors focus:border-line-strong"
          />
          <button
            type="submit"
            disabled={busy || !password}
            className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
          {error && <p className="w-full text-sm text-accent-500">{error}</p>}
        </form>
      )}
    </li>
  );
}

function AddPasskey({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { challengeId, options } = await api.post<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>("/api/admin/account/passkeys/options");
      const response = await startRegistration({ optionsJSON: options });
      await api.post("/api/admin/account/passkeys", {
        challengeId,
        password,
        name: name.trim(),
        response,
      });
      setOpen(false);
      setName("");
      setPassword("");
      onAdded();
    } catch (err) {
      if (err instanceof Error && err.name === "SecurityError") {
        // Browsers only allow passkeys on a domain (or localhost) — a bare IP
        // address like http://192.168.1.20:7373 can never work.
        setError("Passkeys need a domain name (or localhost) — they can't be created when the app is opened by IP address.");
      } else if (err instanceof Error && err.name === "InvalidStateError") {
        setError("This device is already registered as a passkey.");
      } else if (err instanceof Error && err.name === "NotAllowedError") {
        setError(null); // the operator dismissed the browser prompt
      } else if (err instanceof ApiError && err.message === "wrong_password") {
        setError("Password is incorrect.");
      } else if (err instanceof ApiError && err.message === "already_registered") {
        setError("This device is already registered as a passkey.");
      } else {
        setError("Couldn't add the passkey. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90"
      >
        Add a passkey
      </button>
    );
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <p className="text-xs text-text-3">
        Your browser will ask you to confirm with Touch ID, Face ID, your device PIN, or a security
        key.
      </p>
      <DialogField
        id="passkey-name"
        label="Name"
        type="text"
        value={name}
        onChange={setName}
        hint="So you can tell your passkeys apart, e.g. “MacBook Touch ID”."
      />
      <DialogField
        id="passkey-password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !password}
          className="rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Waiting for your device…" : "Create passkey"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-4 py-2 text-sm font-medium text-text-2 hover:bg-surface-3"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function WebhookSection({ onChanged }: { onChanged: () => void }) {
  const me = useQuery({ queryKey: ["admin-me"], queryFn: () => api.get<Me>("/api/admin/me") });
  const [url, setUrl] = useState<string | null>(null);
  const value = url ?? me.data?.webhookUrl ?? "";
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string | null) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.post<{ webhookUrl: string | null }>("/api/admin/account/webhook", {
        webhookUrl: next,
      });
      setUrl(res.webhookUrl ?? "");
      onChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof ApiError && err.message === "invalid_url" ? "That doesn't look like a URL." : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-text-1">Notifications</h3>
        <p className="mt-0.5 text-xs text-text-3">
          Optional webhook pinged when a client submits their selection — paste a Discord, Slack, or
          ntfy URL.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          value={value}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none transition-colors focus:border-line-strong"
        />
        <button
          onClick={() => void save(value.trim() || null)}
          disabled={saving}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3 disabled:opacity-50"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </div>
      {error && <p className="text-sm text-accent-500">{error}</p>}
    </div>
  );
}

function TwoFactorSection({
  onChanged,
  onHoldChange,
}: {
  onChanged: () => void;
  onHoldChange: (held: boolean) => void;
}) {
  const me = useQuery({ queryKey: ["admin-me"], queryFn: () => api.get<Me>("/api/admin/me") });
  const enabled = me.data?.twoFactorEnabled ?? false;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-text-1">Two-factor authentication</h3>
          <p className="mt-0.5 text-xs text-text-3">
            {enabled
              ? `On — ${me.data?.backupCodesRemaining ?? 0} backup codes left.`
              : "Add a code from an authenticator app to your login. Strongly recommended if this is on the internet."}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            enabled ? "bg-text-1 text-invert" : "bg-surface-3 text-text-2"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>
      {enabled ? (
        <Disable2fa onChanged={onChanged} />
      ) : (
        <Enable2fa onChanged={onChanged} onHoldChange={onHoldChange} />
      )}
    </div>
  );
}

function Enable2fa({
  onChanged,
  onHoldChange,
}: {
  onChanged: () => void;
  onHoldChange: (held: boolean) => void;
}) {
  const [enrollment, setEnrollment] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Hold the whole dialog open while unacknowledged backup codes are showing;
  // release on acknowledge or if this view unmounts for any reason.
  useEffect(() => {
    onHoldChange(Boolean(backupCodes));
    return () => onHoldChange(false);
  }, [backupCodes, onHoldChange]);

  async function startSetup() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ qrDataUrl: string; secret: string }>("/api/admin/account/2fa/setup");
      setEnrollment(res);
    } catch {
      setError("Couldn't start setup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ backupCodes: string[] }>("/api/admin/account/2fa/enable", {
        password,
        code: code.trim(),
      });
      // Show the backup codes and hold here — calling onChanged() now would
      // refetch status, flip the section to "enabled", and unmount this view
      // before the operator ever sees the codes. Refresh only on acknowledge.
      setBackupCodes(res.backupCodes);
    } catch (err) {
      if (err instanceof ApiError && err.message === "wrong_password") setError("Password is incorrect.");
      else if (err instanceof ApiError && err.message === "invalid_code") setError("That code isn't right — check your app's clock and try the current code.");
      else setError("Couldn't enable two-factor. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (backupCodes) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
        <p className="text-sm font-medium text-text-1">Save your backup codes</p>
        <p className="text-xs text-text-3">
          Each works once if you lose your authenticator. Store them somewhere safe — they won't be
          shown again.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm text-text-1">
          {backupCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigator.clipboard.writeText(backupCodes.join("\n"))}
            className="text-xs font-medium text-text-2 underline decoration-line-strong underline-offset-2 hover:text-text-1"
          >
            Copy all
          </button>
          <button
            onClick={onChanged}
            className="ml-auto rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90"
          >
            I've saved them
          </button>
        </div>
      </div>
    );
  }

  if (!enrollment) {
    return (
      <button
        onClick={() => void startSetup()}
        disabled={busy}
        className="self-start rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Starting…" : "Enable two-factor"}
      </button>
    );
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <p className="text-xs text-text-3">
        Scan this with an authenticator app (or enter the key manually), then enter the 6-digit code.
      </p>
      <img
        src={enrollment.qrDataUrl}
        alt="Two-factor QR code"
        width={180}
        height={180}
        className="self-center rounded-lg bg-white p-2"
      />
      <p className="break-all text-center font-mono text-xs text-text-3">{enrollment.secret}</p>
      <DialogField id="tfa-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <DialogField id="tfa-code" label="6-digit code" type="text" value={code} onChange={setCode} />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      <button
        type="submit"
        disabled={busy || !password || code.trim().length < 6}
        className="self-start rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Verifying…" : "Confirm & turn on"}
      </button>
    </form>
  );
}

function Disable2fa({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/api/admin/account/2fa/disable", { password, code: code.trim() });
      onChanged();
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.message === "wrong_password") setError("Password is incorrect.");
      else if (err instanceof ApiError && err.message === "invalid_code") setError("That code isn't right.");
      else setError("Couldn't disable two-factor. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3"
      >
        Disable two-factor
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <p className="text-xs text-text-3">Confirm with your password and a current code to turn it off.</p>
      <DialogField id="tfa-off-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <DialogField id="tfa-off-code" label="Code (or a backup code)" type="text" value={code} onChange={setCode} />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !password || !code.trim()}
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Disabling…" : "Disable"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-text-2 hover:bg-surface-3">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("New passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      await api.post("/api/admin/account/password", { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Current password is incorrect.");
      } else {
        setError("Couldn't update the password. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
      <h3 className="text-sm font-medium text-text-1">Change password</h3>
      <DialogField
        id="current-password"
        label="Current password"
        type="password"
        value={currentPassword}
        onChange={setCurrentPassword}
        autoComplete="current-password"
      />
      <DialogField
        id="new-password"
        label="New password"
        type="password"
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        hint="At least 12 characters."
      />
      <DialogField
        id="confirm-password"
        label="Confirm new password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      {success && (
        <p className="text-sm text-text-2">Password updated. Other devices have been signed out.</p>
      )}
      <button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirm}
        className="self-start rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

function ChangeEmailForm({ onChanged }: { onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await api.post("/api/admin/account/email", { password, email });
      setSuccess(true);
      setPassword("");
      setEmail("");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Password is incorrect.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("That doesn't look like a valid email address.");
      } else {
        setError("Couldn't update the email. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-text-1">Change email</h3>
      <DialogField
        id="account-email"
        label="New email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <DialogField
        id="email-password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      {success && <p className="text-sm text-text-2">Email updated.</p>}
      <button
        type="submit"
        disabled={saving || !password || !email}
        className="self-start rounded-lg border border-line px-4 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Updating…" : "Update email"}
      </button>
    </form>
  );
}

function DialogField({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-2">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none transition-colors focus:border-line-strong"
      />
      {hint && <span className="text-xs text-text-3">{hint}</span>}
    </div>
  );
}
