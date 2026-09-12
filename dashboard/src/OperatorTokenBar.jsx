import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';

// The engine refused a command because this browser holds no operator token.
//
// Reading telemetry needs nothing; every command — the Auto-Pilot switch, a zone override,
// a building-model switch, a plug policy — needs ECON_ADMIN_TOKEN. An engine with no token
// set is in demo mode and accepts everything, so the dashboard optimistically assumes it is
// authorised and only learns otherwise when a command comes back refused.
//
// Before this existed, that refusal was console-only: the switch flipped back, nothing
// appeared on screen, and the operator had no way to tell an auth wall from a broken
// toggle. The token input lived solely inside the blueprint-import panel, behind a 401,
// which is not a place anyone looks when Auto-Pilot will not turn on.
//
// Silent while authorised — this renders nothing until a command is actually refused.
export default function OperatorTokenBar({ authorized, onAuthorize }) {
  const [token, setToken] = useState('');
  const [rejected, setRejected] = useState(false);

  if (authorized) return null;

  // Pasted tokens arrive wrapped in the punctuation of wherever they were copied from:
  // surrounding quotes from a .env line or a setItem() call, a stray newline from a
  // terminal, or a zero-width character from a chat client. The engine compares the string
  // exactly and answers "invalid token" for any of them, which reads as a wrong credential
  // rather than a dirty paste. Strip what is never part of the token.
  const clean = (raw) => (raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // zero-width: invisible, and fatal
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();

  const submit = (e) => {
    e.preventDefault();
    const t = clean(token);
    if (!t) return;
    // authorize() stores the token and re-auths the LIVE socket. If the engine rejects it,
    // wsAuthorized stays false and this bar stays up, which is the honest outcome.
    onAuthorize(t);
    setRejected(true); // cleared implicitly: the bar unmounts when auth succeeds
    setToken('');
  };

  return (
    <form
      role="alert"
      onSubmit={submit}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '6px 12px', borderRadius: '8px',
        background: 'rgba(255,159,10,0.12)', border: '1px solid rgba(255,159,10,0.45)',
        color: 'var(--accent-amber, #FF9F0A)', fontSize: '11px', fontWeight: 600,
        letterSpacing: '0.03em',
      }}
    >
      <KeyRound size={12} style={{ flexShrink: 0 }} />
      <span>
        {rejected
          ? 'TOKEN REJECTED — commands are still refused'
          : 'COMMANDS REFUSED — this engine requires an operator token'}
      </span>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="ECON_ADMIN_TOKEN"
        autoComplete="off"
        aria-label="Operator token"
        style={{
          background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,159,10,0.35)',
          borderRadius: '5px', color: 'var(--text-primary, #fff)', padding: '3px 7px',
          fontSize: '11px', fontFamily: 'inherit', width: '190px', outline: 'none',
        }}
      />
      <button
        type="submit"
        disabled={!token.trim()}
        style={{
          background: token.trim() ? 'var(--accent-amber, #FF9F0A)' : 'rgba(255,159,10,0.25)',
          color: token.trim() ? '#000' : 'rgba(255,255,255,0.5)',
          border: 'none', borderRadius: '5px', padding: '3px 10px',
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em',
          cursor: token.trim() ? 'pointer' : 'default',
        }}
      >
        AUTHORIZE
      </button>
    </form>
  );
}
