import React from 'react';
import ReactDOM from 'react-dom/client';
import { UpdateBanner } from 'digital-boardgame-framework/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {/* Renders nothing unless a newer build is live — polls /version.json and
        compares against the SHA baked in at build time. Mounted once at the
        root so it covers every route/tab. */}
    <UpdateBanner currentBuild={__DBF_BUILD_ID__} />
  </React.StrictMode>
);
