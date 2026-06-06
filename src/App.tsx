import { useState, useEffect } from 'react';
import SystemsTab from './devtabs/SystemsTab';
import AdjacencyTab from './devtabs/AdjacencyTab';
import RegionsTab from './devtabs/RegionsTab';
import ResourcesTab from './devtabs/ResourcesTab';
import PositionsTab from './devtabs/PositionsTab';
import MaskTab from './devtabs/MaskTab';
import SilhouetteTab from './devtabs/SilhouetteTab';
import TokensTab from './devtabs/TokensTab';
import LeadersTab from './devtabs/LeadersTab';
import CardsTab from './devtabs/CardsTab';
import ProbeTab from './devtabs/ProbeTab';
import PlayTab from './play/PlayTab';
import Lobby from './online/Lobby';
import OnlinePlay from './online/OnlinePlay';
import { readOnlineInvite } from './online/gameClient';

type TabId = 'play' | 'systems' | 'adjacency' | 'regions' | 'resources' | 'positions' | 'mask' | 'silhouette' | 'tokens' | 'leaders' | 'cards' | 'probe';

const DEV_TABS: { id: TabId; label: string }[] = [
  { id: 'systems', label: 'systems' },
  { id: 'adjacency', label: 'adjacency' },
  { id: 'regions', label: 'regions' },
  { id: 'resources', label: 'resources' },
  { id: 'positions', label: 'positions' },
  { id: 'mask', label: 'mask' },
  { id: 'silhouette', label: 'silhouette' },
  { id: 'tokens', label: 'tokens' },
  { id: 'leaders', label: 'leaders' },
  { id: 'cards', label: 'cards' },
  { id: 'probe', label: 'probe' },
];

function isDevMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('dev') === '1') {
    localStorage.setItem('rebellion-dev', '1');
    return true;
  }
  if (params.get('dev') === '0') {
    localStorage.removeItem('rebellion-dev');
    return false;
  }
  return localStorage.getItem('rebellion-dev') === '1';
}

export default function App() {
  const [dev, setDev] = useState(isDevMode());
  const [tab, setTab] = useState<TabId>(dev ? 'systems' : 'play');
  const [showLobby, setShowLobby] = useState(false);

  useEffect(() => {
    document.title = dev ? 'Star Wars: Rebellion — Dev' : 'Star Wars: Rebellion';
  }, [dev]);

  // An invite deep-link (?g=<gameId>&t=<token>) takes over the whole app and
  // opens straight into the online game, covering every route.
  const invite = readOnlineInvite();
  if (invite) return <OnlinePlay gameId={invite.gameId} token={invite.token} />;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Star Wars: Rebellion</h1>
        <nav className="tab-bar">
          <button
            className={`tab-button ${tab === 'play' && !showLobby ? 'active' : ''}`}
            onClick={() => { setShowLobby(false); setTab('play'); }}
          >
            play
          </button>
          <button
            className={`tab-button ${showLobby ? 'active' : ''}`}
            onClick={() => setShowLobby(true)}
            title="Play a two-player game online"
          >
            play online
          </button>
          {dev &&
            DEV_TABS.map((t) => (
              <button
                key={t.id}
                className={`tab-button dev-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
        </nav>
        <div style={{ flex: 1 }} />
        {dev && (
          <button
            className="tab-button"
            onClick={() => {
              localStorage.removeItem('rebellion-dev');
              setDev(false);
              setTab('play');
            }}
            title="Hide dev tabs (append ?dev=1 to URL to re-enable)"
          >
            hide dev tabs
          </button>
        )}
      </header>

      <main className="app-main">
        {showLobby && <Lobby onClose={() => setShowLobby(false)} />}
        {!showLobby && tab === 'play' && <PlayTab />}
        {tab === 'systems' && <SystemsTab />}
        {tab === 'adjacency' && <AdjacencyTab />}
        {tab === 'regions' && <RegionsTab />}
        {tab === 'resources' && <ResourcesTab />}
        {tab === 'positions' && <PositionsTab />}
        {tab === 'mask' && <MaskTab />}
        {tab === 'silhouette' && <SilhouetteTab />}
        {tab === 'tokens' && <TokensTab />}
        {tab === 'leaders' && <LeadersTab />}
        {tab === 'cards' && <CardsTab />}
        {tab === 'probe' && <ProbeTab />}
      </main>
    </div>
  );
}
