import React from 'react';
import { ScrollView, View } from 'react-native';
import { errorHint, isAccountSignInError, isSignInError } from '../state/errorHints';
import { clearErrors, closeErrors, fullDate, openDialog, showErrors, useStore } from '../state/store';
import * as live from '../state/live';
import { FONT, useTheme } from '../theme';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/overlays';
import { Button, Txt, useKeyboard } from '../ui/primitives';

/**
 * Errors in full: what failed, what to do about it, and git's own output (selectable, scrollable).
 * Opens on every error; the session's earlier errors are a step away (‹ ›), the status bar reopens it.
 * "Ask AI" hands the error to the agent, which looks into it in the repository it happened in.
 */
export function ErrorDialogHost() {
  const open = useStore((s) => s.errorOpen);
  const errors = useStore((s) => s.errors);
  const idx = open == null ? -1 : errors.findIndex((e) => e.id === open);
  if (idx < 0) return null;
  return <ErrorDialog idx={idx} />;
}

function ErrorDialog({ idx }: { idx: number }) {
  const t = useTheme();
  const errors = useStore((s) => s.errors);
  const e = errors[idx];
  const hint = errorHint(e.title, e.detail);
  // a remote refused the credentials: the repository's SSH key / account is one click away
  const signIn = live.isLiveActive() && isSignInError(e.title, e.detail);
  // a GitHub account whose sign-in no longer works: Accounts, where it is signed in again
  const account = isAccountSignInError(e.title, e.detail);
  const newer = idx > 0 ? errors[idx - 1] : null;
  const older = idx < errors.length - 1 ? errors[idx + 1] : null;
  useKeyboard((k) => {
    if (k.key === 'Enter' && !k.meta) {
      k.preventDefault();
      closeErrors();
    } else if (k.key === 'ArrowLeft' && newer) showErrors(newer.id);
    else if (k.key === 'ArrowRight' && older) showErrors(older.id);
  }, { errorLayer: true });
  const copy = () => live.copyText(`${e.title}\n${e.detail ?? ''}`.trim());
  return (
    <Modal
      layer="error"
      title={errors.length > 1 ? `Error ${idx + 1} of ${errors.length}` : 'Error'}
      width={680}
      onClose={closeErrors}
      icon={<Icon name="warning" size={15} color={t.del} />}
      footer={
        <>
          {errors.length > 1 && (
            <>
              <Button small label="‹ Newer" disabled={!newer} onPress={() => newer && showErrors(newer.id)} testID="error-newer" />
              <Button small label="Older ›" disabled={!older} style={{ marginLeft: 6 }} onPress={() => older && showErrors(older.id)} testID="error-older" />
            </>
          )}
          <View style={{ flex: 1 }} />
          {e.action && (
            <Button
              small
              danger
              label={e.action.label}
              style={{ marginRight: 6 }}
              onPress={() => {
                const run = e.action!.run;
                closeErrors();
                run();
              }}
              testID="error-action"
            />
          )}
          {account && (
            <Button
              small
              primary
              label="Sign in again…"
              icon="github"
              style={{ marginRight: 6 }}
              onPress={() => {
                closeErrors();
                openDialog({ type: 'accounts', tab: 'github' });
              }}
              testID="error-accounts"
            />
          )}
          {signIn && !account && (
            <Button
              small
              primary
              label="Connection…"
              icon="key"
              style={{ marginRight: 6 }}
              onPress={() => {
                closeErrors();
                openDialog({ type: 'connection' });
              }}
              testID="error-connection"
            />
          )}
          <Button
            small
            icon="agent"
            label="Ask AI"
            style={{ marginRight: 6 }}
            onPress={() => {
              closeErrors();
              // an error thrown by Prong's own code is a bug in the app; the rest happened in a repository
              live.askAgentAbout({ title: e.title, detail: e.detail, repo: e.repo, app: /^Unexpected error/.test(e.title) });
            }}
            testID="error-ask-ai"
          />
          <Button small label="Clear log" onPress={clearErrors} testID="error-clear" />
          <Button small label="Copy" icon="copy" style={{ marginLeft: 6 }} onPress={copy} testID="error-copy" />
          <Button label="Close" primary style={{ marginLeft: 8 }} onPress={closeErrors} testID="error-close" />
        </>
      }
    >
      <View testID="error-dialog">
        <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Txt size={FONT.lg} weight="600" color={t.del} selectable testID="error-title">
            {e.title}
          </Txt>
          {e.count > 1 && (
            <Txt size={FONT.sm} faint style={{ marginLeft: 8 }}>
              ×{e.count}
            </Txt>
          )}
        </View>
        <Txt size={FONT.xs} faint style={{ marginTop: 2 }}>
          {fullDate(e.at)}
        </Txt>
        {hint && (
          <View style={{ flexDirection: 'row', marginTop: 12, padding: 10, borderWidth: 1, borderColor: t.info + '55', backgroundColor: t.info + '14' }} testID="error-hint">
            <Icon name="info" size={13} color={t.info} />
            <Txt size={FONT.sm} style={{ marginLeft: 8, flex: 1 }}>
              {hint}
            </Txt>
          </View>
        )}
        {e.detail ? (
          <ScrollView style={{ marginTop: 12, maxHeight: 340, borderWidth: 1, borderColor: t.border, backgroundColor: t.bg }} contentContainerStyle={{ padding: 10 }}>
            <Txt size={FONT.sm} mono selectable testID="error-detail" style={{ whiteSpace: 'pre-wrap' } as any}>
              {e.detail}
            </Txt>
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}
