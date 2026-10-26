import React, { useEffect } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { useFonts, JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { DialogHost } from './src/components/dialogs';
import { ErrorDialogHost } from './src/components/ErrorDialog';
import { RepoPickerHost } from './src/components/RepoPicker';
import { RepoTabs } from './src/components/Toolbar';
import { Repository } from './src/screens/Repository';
import { Welcome } from './src/screens/Welcome';
import { closeErrors, closeRepoPicker, closeTab, commit, getState, openRepoPickerCentered, openDialog, setMergeCollapsed, setSection, setState, stageFile, stepUiScale, toast, toggleAgent, toggleAgentBar, unstageFile, useStore } from './src/state/store';
import { AgentPanel } from './src/components/AgentPanel';
import { AgentNotices } from './src/components/AgentBar';
import { isDark, THEMES, ThemeContext } from './src/theme';
import { ContextMenuHost, PickerHost } from './src/ui/overlays';
import { ErrorBoundary, reportCrash, setCrashAssistant } from './src/ui/ErrorBoundary';
import { applyLocalUi, askAgentAbout, bootstrap as bootstrapEngine, client, restoreAgentSession, undoLast } from './src/state/live';
import { setSystemIconBase } from './src/ui/FileIcon';
import { setAvatarBase, useKeyboard } from './src/ui/primitives';

/** After a crash in the repository view: drop the selection that was being rendered, keep the repository open. */
function recoverRepoView() {
  const s = getState();
  const id = s.activeTab;
  if (!id || !s.repoStates[id]) return;
  const r = s.repoStates[id];
  setState({ repoStates: { ...s.repoStates, [id]: { ...r, selectedFile: null, blame: null, historyPath: null } }, contextMenu: null, dialog: null });
  toast('Recovered from an error', 'info', 'the selection was reset');
}
/** Root-level crash: back to the welcome screen with every dialog closed. */
function recoverApp() {
  setState({ screen: 'welcome', dialog: null, contextMenu: null, operation: null });
}

export default function App() {
  const themeName = useStore((s) => s.theme);
  const screen = useStore((s) => s.screen);
  const agentOpen = useStore((s) => s.agent.open);
  const uiScale = useStore((s) => s.uiScale);
  const theme = THEMES[themeName];
  const win = useWindowDimensions();
  const [fontsLoaded] = useFonts({ JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold, JetBrainsMono_700Bold });

  useEffect(() => {
    setAvatarBase(client.baseUrl);
    setSystemIconBase(client.baseUrl);
    applyLocalUi();
    restoreAgentSession();
    // a crashed panel's "Ask AI": the bug is in Prong's own code
    setCrashAssistant((title, detail) => askAgentAbout({ title, detail, app: true }));
    // the macOS shell's Edit → Undo (⌘Z): a text field undoes its typing, anything else the last action
    (window as any).__prongUndo = () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) document.execCommand('undo');
      else undoLast();
    };
    // errors outside React (event handlers, promises) are logged and shown, never left to blank the window
    if (Platform.OS === 'web') {
      const onErr = (e: ErrorEvent) => {
        reportCrash('window', e.error ?? e.message);
        toast('Unexpected error', 'error', String(e.error?.stack ?? e.message));
      };
      const onRej = (e: PromiseRejectionEvent) => {
        reportCrash('promise', e.reason);
        toast('Unexpected error', 'error', String(e.reason?.stack ?? e.reason?.message ?? e.reason));
      };
      window.addEventListener('error', onErr);
      window.addEventListener('unhandledrejection', onRej);
      return () => {
        window.removeEventListener('error', onErr);
        window.removeEventListener('unhandledrejection', onRej);
      };
    }
  }, []);

  useEffect(() => {
    void bootstrapEngine();
    const id = setInterval(() => {
      if (!getState().engine.online) void bootstrapEngine();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', prevent);
    document.body.style.backgroundColor = theme.bg;
    document.body.style.overflow = 'hidden';
    document.title = 'Prong';
    // Frosted glass for popups (dataSet.glass → data-glass) and crisp monospace rendering.
    let st = document.getElementById('prong-css') as HTMLStyleElement | null;
    if (!st) {
      st = document.createElement('style');
      st.id = 'prong-css';
      document.head.appendChild(st);
    }
    st.textContent = `[data-glass]{backdrop-filter:blur(34px) saturate(0.7) contrast(0.92);-webkit-backdrop-filter:blur(34px) saturate(0.7) contrast(0.92)}
      body{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
      input::selection,textarea::selection{background:${theme.selection};color:${theme.selectionText}}
      [data-zoomroot]{-webkit-user-select:none;user-select:none}
      input,textarea,[data-selectable]{-webkit-user-select:text;user-select:text}
      ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:${theme.borderStrong};border:3px solid ${theme.panel}}::-webkit-scrollbar-track{background:transparent}`;
    return () => document.removeEventListener('contextmenu', prevent);
  }, [theme]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // Interface scale: CSS zoom on the app root; the root is sized to window/scale so it always fits the window.
    let st = document.getElementById('prong-zoom') as HTMLStyleElement | null;
    if (!st) {
      st = document.createElement('style');
      st.id = 'prong-zoom';
      document.head.appendChild(st);
    }
    st.textContent = `[data-zoomroot]{zoom:${uiScale}}`;
  }, [uiScale]);

  useKeyboard((e) => {
    const s = getState();
    const typing = e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
    if (e.meta && e.key === 'k') return (e.preventDefault(), openDialog({ type: 'palette' }));
    if (e.meta && e.key === ',') return (e.preventDefault(), openDialog({ type: 'accounts', tab: 'general' }));
    if (e.meta && e.key === '/') return (e.preventDefault(), openDialog({ type: 'shortcuts' }));
    if (e.meta && e.key === 't') return (e.preventDefault(), openRepoPickerCentered());
    if (e.key === 'Escape' && s.agent.bar && !s.dialog && !s.agent.busy) return toggleAgentBar(false);
    if (e.meta && e.shift && e.key.toLowerCase() === 'j') return (e.preventDefault(), toggleAgent());
    if (e.meta && e.key === 'j') return (e.preventDefault(), toggleAgentBar());
    if (e.meta && (e.key === '=' || e.key === '+')) return (e.preventDefault(), stepUiScale(1));
    if (e.meta && e.key === '-') return (e.preventDefault(), stepUiScale(-1));
    if (e.meta && e.key === '0') return (e.preventDefault(), stepUiScale(0));
    if (s.screen !== 'repo' || s.dialog) return;
    if (e.meta && e.key === 'w') return (e.preventDefault(), s.activeTab && closeTab(s.activeTab));
    if (e.meta && e.key === '1') return (e.preventDefault(), setSection('changes'));
    if (e.meta && e.key === '2') return (e.preventDefault(), setSection('commits'));
    if (e.meta && e.key === 'b') return (e.preventDefault(), setState({ sidebarCollapsed: !s.sidebarCollapsed }));
    if (e.meta && e.key === 'Enter') return (e.preventDefault(), commit(s.commitAction === 'commit-push'));
    // ⌘Z in a text field is the field's own undo; elsewhere it takes back the repository's last action
    if (e.meta && !e.shift && e.key.toLowerCase() === 'z' && !typing) return (e.preventDefault(), undoLast());
    // as the toolbar buttons: the dialogs with their options
    if (e.meta && e.shift && e.key.toLowerCase() === 'f') return (e.preventDefault(), openDialog({ type: 'fetch' }));
    if (e.meta && e.shift && e.key.toLowerCase() === 'p') return (e.preventDefault(), openDialog({ type: 'push' }));
    if (e.meta && e.shift && e.key.toLowerCase() === 'l') return (e.preventDefault(), openDialog({ type: 'pull' }));
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
      const r = s.repoStates[s.activeTab ?? ''];
      if (r?.section === 'commits' && r.selectedArea === 'commit' && r.selectedCommit) {
        e.preventDefault();
        setMergeCollapsed(r.selectedCommit, e.key === 'ArrowLeft');
      }
    }
    if (e.key === ' ' && !typing) {
      const r = s.repoStates[s.activeTab ?? ''];
      if (r?.section === 'changes' && r.selectedFile) {
        e.preventDefault();
        if (r.selectedArea === 'unstaged') stageFile(r.selectedFile);
        else if (r.selectedArea === 'staged') unstageFile(r.selectedFile);
      }
    }
  });

  // fonts swap in when loaded; the UI renders immediately with the platform fallback
  void fontsLoaded;
  return (
    <ThemeContext.Provider value={theme}>
      <ErrorBoundary name="App" root onRecover={recoverApp}>
        <View {...({ dataSet: { zoomroot: '1' } } as any)} style={[styles.root, { backgroundColor: theme.bg }, Platform.OS === 'web' && { width: win.width / uiScale, height: win.height / uiScale }]}>
          <ErrorBoundary name="Tabs">
            <RepoTabs />
          </ErrorBoundary>
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ErrorBoundary name={screen === 'welcome' ? 'Welcome' : 'Repository'} onRecover={recoverRepoView}>
                {screen === 'welcome' ? <Welcome /> : <Repository />}
              </ErrorBoundary>
            </View>
            {agentOpen && (
              <ErrorBoundary name="Agent panel" onRecover={() => setState((s) => ({ agent: { ...s.agent, open: false } }))}>
                <AgentPanel />
              </ErrorBoundary>
            )}
          </View>
          <ErrorBoundary name="Dialog" onRecover={() => setState({ dialog: null })}>
            <DialogHost />
          </ErrorBoundary>
          <ErrorBoundary name="Agent notices">
            <AgentNotices />
          </ErrorBoundary>
          {/* above every dialog: an operation started from a dialog can fail too */}
          <ErrorBoundary name="Error dialog" onRecover={closeErrors}>
            <ErrorDialogHost />
          </ErrorBoundary>
          <ErrorBoundary name="Repository list" onRecover={closeRepoPicker}>
            <RepoPickerHost />
          </ErrorBoundary>
          <ContextMenuHost />
          <PickerHost />
          <ExpoStatusBar style={isDark(themeName) ? 'light' : 'dark'} />
        </View>
      </ErrorBoundary>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
});
