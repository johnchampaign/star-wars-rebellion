// js/renderer.js
// DOM rendering utilities for log viewer, game state panel, and timeline visualization

const Renderer = (() => {
  'use strict';

  // --- Design System Constants ---
  const DS = {
    colors: {
      primary: '#1a1a2e',
      secondary: '#16213e',
      accent: '#0f3460',
      highlight: '#e94560',
      text: '#eaeaea',
      background: '#0a0a1a',
      success: '#2ecc71',
      warning: '#f39c12',
      error: '#e74c3c',
    },
    typography: {
      headings: "'Orbitron', sans-serif",
      body: "'Roboto Mono', monospace",
      baseSize: '16px',
      scale: '1.25',
    },
    spacing: {
      xs: '4px',
      sm: '8px',
      md: '16px',
      lg: '24px',
      xl: '48px',
    },
  };

  // --- Utility Functions ---
  function createElement(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') {
        el.className = value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('data-')) {
        el.setAttribute(key, value);
      } else if (key === 'innerHTML') {
        el.innerHTML = value;
      } else {
        el.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'string' || typeof child === 'number') {
        el.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
        el.appendChild(child);
      } else if (Array.isArray(child)) {
        child.forEach((c) => {
          if (c instanceof Node) el.appendChild(c);
          else if (c != null) el.appendChild(document.createTextNode(String(c)));
        });
      }
    }
    return el;
  }

  function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getPhaseColor(phase) {
    const phaseColors = {
      deployment: DS.colors.accent,
      assignment: DS.colors.warning,
      execution: DS.colors.highlight,
      refresh: DS.colors.success,
    };
    return phaseColors[phase?.toLowerCase()] || DS.colors.text;
  }

  function getSideColor(side) {
    return side?.toLowerCase() === 'rebel' ? DS.colors.success : DS.colors.highlight;
  }

  // --- Log Viewer ---
  class LogViewer {
    constructor(containerId, options = {}) {
      this.container = document.getElementById(containerId);
      if (!this.container) throw new Error(`Container #${containerId} not found`);
      this.maxEntries = options.maxEntries || 200;
      this.filter = options.filter || null;
      this.entries = [];
      this._init();
    }

    _init() {
      this.container.style.cssText = `
        background: ${DS.colors.background};
        color: ${DS.colors.text};
        font-family: ${DS.typography.body};
        font-size: ${DS.typography.baseSize};
        padding: ${DS.spacing.md};
        border: 1px solid ${DS.colors.accent};
        border-radius: 4px;
        overflow-y: auto;
        max-height: 600px;
        line-height: 1.6;
      `;
    }

    addEntry(entry) {
      if (!entry || !entry.message) return;
      if (this.filter && !this.filter(entry)) return;

      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        this.entries.shift();
        this._rebuild();
      } else {
        this._appendEntry(entry);
      }
    }

    _appendEntry(entry) {
      const row = this._createEntryElement(entry);
      this.container.appendChild(row);
      this.container.scrollTop = this.container.scrollHeight;
    }

    _rebuild() {
      this.container.innerHTML = '';
      for (const entry of this.entries) {
        this.container.appendChild(this._createEntryElement(entry));
      }
      this.container.scrollTop = this.container.scrollHeight;
    }

    _createEntryElement(entry) {
      const timestamp = entry.timestamp ? formatTimestamp(entry.timestamp) : '';
      const side = entry.side || '';
      const phase = entry.phase || '';
      const message = entry.message || '';

      const row = createElement('div', {
        style: {
          padding: `${DS.spacing.xs} 0`,
          borderBottom: `1px solid ${DS.colors.secondary}`,
          display: 'flex',
          gap: DS.spacing.sm,
          alignItems: 'flex-start',
        },
      });

      // Timestamp
      if (timestamp) {
        row.appendChild(
          createElement('span', {
            style: {
              color: DS.colors.accent,
              minWidth: '70px',
              flexShrink: 0,
              fontSize: '0.85em',
            },
          }, timestamp)
        );
      }

      // Side badge
      if (side) {
        const sideColor = getSideColor(side);
        row.appendChild(
          createElement('span', {
            style: {
              color: sideColor,
              fontWeight: 'bold',
              minWidth: '60px',
              flexShrink: 0,
              textTransform: 'uppercase',
              fontSize: '0.85em',
            },
          }, side)
        );
      }

      // Phase badge
      if (phase) {
        const phaseColor = getPhaseColor(phase);
        row.appendChild(
          createElement('span', {
            style: {
              color: phaseColor,
              minWidth: '90px',
              flexShrink: 0,
              fontSize: '0.85em',
            },
          }, phase)
        );
      }

      // Message
      row.appendChild(
        createElement('span', {
          style: {
            flex: 1,
            wordBreak: 'break-word',
          },
        }, sanitizeHTML(message))
      );

      return row;
    }

    clear() {
      this.entries = [];
      this.container.innerHTML = '';
    }

    setFilter(filterFn) {
      this.filter = filterFn;
      this._rebuild();
    }
  }

  // --- Game State Panel ---
  class GameStatePanel {
    constructor(containerId, options = {}) {
      this.container = document.getElementById(containerId);
      if (!this.container) throw new Error(`Container #${containerId} not found`);
      this.options = options;
      this.state = null;
      this._init();
    }

    _init() {
      this.container.style.cssText = `
        background: ${DS.colors.background};
        color: ${DS.colors.text};
        font-family: ${DS.typography.body};
        font-size: ${DS.typography.baseSize};
        padding: ${DS.spacing.md};
        border: 1px solid ${DS.colors.accent};
        border-radius: 4px;
      `;
    }

    update(state) {
      this.state = state;
      this.render();
    }

    render() {
      this.container.innerHTML = '';
      if (!this.state) {
        this.container.appendChild(
          createElement('div', { style: { color: DS.colors.accent, textAlign: 'center', padding: DS.spacing.lg } }, 'No game state available')
        );
        return;
      }

      const sections = [];

      // Phase indicator
      if (this.state.phase) {
        sections.push(this._createPhaseSection(this.state.phase));
      }

      // Turn info
      if (this.state.turn != null) {
        sections.push(this._createInfoSection('Turn', String(this.state.turn)));
      }

      // Player info
      if (this.state.humanSide || this.state.aiSide) {
        sections.push(this._createPlayersSection(this.state.humanSide, this.state.aiSide));
      }

      // Resources / Credits
      if (this.state.credits != null) {
        sections.push(this._createInfoSection('Credits', String(this.state.credits), DS.colors.warning));
      }

      // Leaders
      if (this.state.leaders && this.state.leaders.length > 0) {
        sections.push(this._createLeadersSection(this.state.leaders));
      }

      // Systems
      if (this.state.systems && this.state.systems.length > 0) {
        sections.push(this._createSystemsSection(this.state.systems));
      }

      // Custom data
      if (this.state.custom && typeof this.state.custom === 'object') {
        sections.push(this._createCustomSection(this.state.custom));
      }

      for (const section of sections) {
        this.container.appendChild(section);
      }
    }

    _createPhaseSection(phase) {
      const phaseColor = getPhaseColor(phase);
      return createElement('div', {
        style: {
          padding: `${DS.spacing.sm} ${DS.spacing.md}`,
          marginBottom: DS.spacing.md,
          background: phaseColor + '22',
          border: `1px solid ${phaseColor}`,
          borderRadius: '4px',
          textAlign: 'center',
          fontWeight: 'bold',
          textTransform: 'uppercase',
          letterSpacing: '2px',
          fontFamily: DS.typography.headings,
        },
      }, `Phase: ${phase}`);
    }

    _createInfoSection(label, value, color = DS.colors.text) {
      return createElement('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          padding: `${DS.spacing.xs} 0`,
          borderBottom: `1px solid ${DS.colors.secondary}`,
        },
      },
        createElement('span', { style: { color: DS.colors.accent } }, label),
        createElement('span', { style: { color, fontWeight: 'bold' } }, value)
      );
    }

    _createPlayersSection(humanSide, aiSide) {
      const section = createElement('div', {
        style: {
          padding: `${DS.spacing.sm} 0`,
          borderBottom: `1px solid ${DS.colors.secondary}`,
          marginBottom: DS.spacing.sm,
        },
      });

      if (humanSide) {
        section.appendChild(
          createElement('div', {
            style: { display: 'flex', justifyContent: 'space-between', padding: `${DS.spacing.xs} 0` },
          },
            createElement('span', { style: { color: DS.colors.accent } }, 'You'),
            createElement('span', { style: { color: getSideColor(humanSide), fontWeight: 'bold' } }, humanSide)
          )
        );
      }

      if (aiSide) {
        section.appendChild(
          createElement('div', {
            style: { display: 'flex', justifyContent: 'space-between', padding: `${DS.spacing.xs} 0` },
          },
            createElement('span', { style: { color: DS.colors.accent } }, 'AI'),
            createElement('span', { style: { color: getSideColor(aiSide), fontWeight: 'bold' } }, aiSide)
          )
        );
      }

      return section;
    }

    _createLeadersSection(leaders) {
      const section = createElement('div', {
        style: {
          padding: `${DS.spacing.sm} 0`,
          borderBottom: `1px solid ${DS.colors.secondary}`,
          marginBottom: DS.spacing.sm,
        },
      });

      section.appendChild(
        createElement('div', {
          style: {
            fontFamily: DS.typography.headings,
            color: DS.colors.highlight,
            marginBottom: DS.spacing.sm,
            fontSize: '0.9em',
            textTransform: 'uppercase',
          },
        }, 'Leaders')
      );

      for (const leader of leaders) {
        const leaderEl = createElement('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            padding: `${DS.spacing.xs} ${DS.spacing.sm}`,
            background: DS.colors.secondary,
            borderRadius: '3px',
            marginBottom: DS.spacing.xs,
            fontSize: '0.9em',
          },
        });

        leaderEl.appendChild(
          createElement('span', {}, leader.name || leader.id || 'Unknown')
        );

        if (leader.status) {
          leaderEl.appendChild(
            createElement('span', {
              style: {
                color: leader.status === 'available' ? DS.colors.success : DS.colors.warning,
                fontSize: '0.85em',
              },
            }, leader.status)
          );
        }

        section.appendChild(leaderEl);
      }

      return section;
    }

    _createSystemsSection(systems) {
      const section = createElement('div', {
        style: {
          padding: `${DS.spacing.sm} 0`,
          borderBottom: `1px solid ${DS.colors.secondary}`,
          marginBottom: DS.spacing.sm,
        },
      });

      section.appendChild(
        createElement('div', {
          style: {
            fontFamily: DS.typography.headings,
            color: DS.colors.highlight,
            marginBottom: DS.spacing.sm,
            fontSize: '0.9em',
            textTransform: 'uppercase',
          },
        }, 'Systems')
      );

      for (const system of systems) {
        const sysEl = createElement('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            padding: `${DS.spacing.xs} ${DS.spacing.sm}`,
            background: DS.colors.secondary,
            borderRadius: '3px',
            marginBottom: DS.spacing.xs,
            fontSize: '0.9em',
          },
        });

        sysEl.appendChild(
          createElement('span', {}, system.name || system.id || 'Unknown')
        );

        if (system.owner) {
          sysEl.appendChild(
            createElement('span', {
              style: { color: getSideColor(system.owner), fontSize: '0.85em' },
            }, system.owner)
          );
        }

        section.appendChild(sysEl);
      }

      return section;
    }

    _createCustomSection(customData) {
      const section = createElement('div', {
        style: {
          padding: `${DS.spacing.sm} 0`,
        },
      });

      section.appendChild(
        createElement('div', {
          style: {
            fontFamily: DS.typography.headings,
            color: DS.colors.highlight,
            marginBottom: DS.spacing.sm,
            fontSize: '0.9em',
            textTransform: 'uppercase',
          },
        }, 'Additional Info')
      );

      for (const [key, value] of Object.entries(customData)) {
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        section.appendChild(
          createElement('div', {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              padding: `${DS.spacing.xs} 0`,
              fontSize: '0.85em',
              borderBottom: `1px solid ${DS.colors.secondary}`,
            },
          },
            createElement('span', { style: { color: DS.colors.accent } }, key),
            createElement('span', { style: { color: DS.colors.text } }, displayValue)
          )
        );
      }

      return section;
    }

    clear() {
      this.state = null;
      this.container.innerHTML = '';
    }
  }

  // --- Timeline Visualization ---
  class Timeline {
    constructor(containerId, options = {}) {
      this.container = document.getElementById(containerId);
      if (!this.container) throw new Error(`Container #${containerId} not found`);
      this.options = {
        maxEvents: options.maxEvents || 100,
        showLabels: options.showLabels !== false,
        animate: options.animate !== false,
        ...options,
      };
      this.events = [];
      this._init();
    }

    _init() {
      this.container.style.cssText = `
        background: ${DS.colors.background};
        color: ${DS.colors.text};
        font-family: ${DS.typography.body};
        font-size: ${DS.typography.baseSize};
        padding: ${DS.spacing.md};
        border: 1px solid ${DS.colors.accent};
        border-radius: 4px;
        position: relative;
        overflow: hidden;
      `;

      // Create timeline line
      this._line = createElement('div', {
        style: {
          position: 'absolute',
          left: '30px',
          top: '0',
          bottom: '0',
          width: '2px',
          background: `linear-gradient(to bottom, ${DS.colors.accent}, ${DS.colors.highlight})`,
        },
      });
      this.container.appendChild(this._line);

      // Create events container
      this._eventsContainer = createElement('div', {
        style: {
          position: 'relative',
          marginLeft: '50px',
          minHeight: '100px',
        },
      });
      this.container.appendChild(this._eventsContainer);
    }

    addEvent(event) {
      if (!event || !event.label) return;

      this.events.push({
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
        id: event.id || `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      });

      if (this.events.length > this.options.maxEvents) {
        const removed = this.events.shift();
        const removedEl = this._eventsContainer.querySelector(`[data-event-id="${removed.id}"]`);
        if (removedEl) removedEl.remove();
      }

      this._appendEvent(this.events[this.events.length - 1]);
    }

    _appendEvent(event) {
      const eventEl = createElement('div', {
        '