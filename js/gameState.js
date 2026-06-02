// js/gameState.js
// Production-grade game state handler for Star Wars Rebellion UI

class GameStateManager {
  constructor(options = {}) {
    this.container = options.container || document.getElementById('game-state-panel');
    this.logContainer = options.logContainer || document.getElementById('log-container');
    this.phaseIndicator = options.phaseIndicator || document.getElementById('phase-indicator');
    this.leaderPoolContainer = options.leaderPoolContainer || document.getElementById('leader-pool');
    
    this.state = {
      currentPhase: null,
      turn: 0,
      humanSide: 'Rebel',
      aiSide: 'Empire',
      leaders: { Rebel: [], Empire: [] },
      missions: { Rebel: [], Empire: [] },
      objectives: { Rebel: [], Empire: [] },
      probes: { Empire: [] },
      logs: []
    };
    
    this.init();
  }

  init() {
    this.renderPhaseIndicator();
    this.renderLeaderPool();
    this.bindEvents();
  }

  bindEvents() {
    document.addEventListener('gameStateUpdate', (e) => this.updateState(e.detail));
    document.addEventListener('logEntry', (e) => this.addLogEntry(e.detail));
  }

  updateState(newState) {
    Object.assign(this.state, newState);
    this.render();
  }

  render() {
    this.renderPhaseIndicator();
    this.renderLeaderPool();
    this.renderGameStateJSON();
    this.renderLogs();
  }

  renderPhaseIndicator() {
    if (!this.phaseIndicator) return;
    
    const phase = this.state.currentPhase || 'waiting';
    const turn = this.state.turn || 0;
    
    this.phaseIndicator.innerHTML = `
      <div class="phase-indicator ${phase.toLowerCase()}">
        <span class="phase-label">Phase: ${phase}</span>
        <span class="turn-label">Turn: ${turn}</span>
        <span class="side-indicator ${this.state.humanSide.toLowerCase()}">
          ${this.state.humanSide} vs ${this.state.aiSide}
        </span>
      </div>
    `;
  }

  renderLeaderPool() {
    if (!this.leaderPoolContainer) return;
    
    const rebelLeaders = this.state.leaders.Rebel || [];
    const empireLeaders = this.state.leaders.Empire || [];
    
    this.leaderPoolContainer.innerHTML = `
      <div class="leader-pool">
        <div class="leader-faction rebel">
          <h3>Rebel Leaders</h3>
          <div class="leader-list">
            ${rebelLeaders.map(leader => `
              <div class="leader-card" data-leader-id="${leader.id}">
                <span class="leader-name">${leader.name}</span>
                <span class="leader-status ${leader.status}">${leader.status}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="leader-faction empire">
          <h3>Empire Leaders</h3>
          <div class="leader-list">
            ${empireLeaders.map(leader => `
              <div class="leader-card" data-leader-id="${leader.id}">
                <span class="leader-name">${leader.name}</span>
                <span class="leader-status ${leader.status}">${leader.status}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderGameStateJSON() {
    if (!this.container) return;
    
    const stateJSON = JSON.stringify(this.state, null, 2);
    this.container.innerHTML = `
      <div class="game-state-json">
        <h2>Game State</h2>
        <pre><code>${this.syntaxHighlight(stateJSON)}</code></pre>
      </div>
    `;
  }

  renderLogs() {
    if (!this.logContainer) return;
    
    const logs = this.state.logs || [];
    this.logContainer.innerHTML = logs.map(log => `
      <div class="log-entry ${log.side ? log.side.toLowerCase() : 'neutral'}">
        <span class="log-timestamp">${log.timestamp || ''}</span>
        <span class="log-turn">t${log.turn || '?'}</span>
        <span class="log-side">${log.side || ''}</span>
        <span class="log-action">${log.action || ''}</span>
        <span class="log-details">${log.details || ''}</span>
      </div>
    `).join('');
    
    // Auto-scroll to bottom
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }

  addLogEntry(entry) {
    if (!this.state.logs) this.state.logs = [];
    this.state.logs.push({
      timestamp: new Date().toISOString(),
      turn: this.state.turn,
      ...entry
    });
    
    // Keep only last 100 entries for performance
    if (this.state.logs.length > 100) {
      this.state.logs = this.state.logs.slice(-100);
    }
    
    this.renderLogs();
  }

  syntaxHighlight(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'key';
          } else {
            cls = 'string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'boolean';
        } else if (/null/.test(match)) {
          cls = 'null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  // Public API methods
  setPhase(phase) {
    this.state.currentPhase = phase;
    this.renderPhaseIndicator();
  }

  setTurn(turn) {
    this.state.turn = turn;
    this.renderPhaseIndicator();
  }

  updateLeaders(side, leaders) {
    this.state.leaders[side] = leaders;
    this.renderLeaderPool();
  }

  parseLogEntry(rawEntry) {
    // Parse log entries from the format shown in the spec
    const parts = rawEntry.split(' ');
    const turn = parts[0] ? parseInt(parts[0].replace('t', '')) : null;
    const side = parts[1] || '';
    const action = parts[2] || '';
    const details = parts.slice(3).join(' ') || '';
    
    return { turn, side, action, details };
  }

  loadFromServerData(serverData) {
    if (serverData.logs) {
      serverData.logs.forEach(log => {
        if (typeof log === 'string') {
          this.addLogEntry(this.parseLogEntry(log));
        } else {
          this.addLogEntry(log);
        }
      });
    }
    
    if (serverData.state) {
      this.updateState(serverData.state);
    }
  }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameStateManager;
}

// Auto-initialize if DOM is ready
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    window.gameState = new GameStateManager();
  });
}