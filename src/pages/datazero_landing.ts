// datazero_landing.ts — Public landing page for datazero.io
// Served at datazero.io/ (unauthenticated)
import { renderShell, PALETTE, escapeHtml } from "../../src/lib/zui";

const GITHUB_REPO = "https://github.com/tokencube/datazero";

function renderLandingBody(): string {
  return /* html */ `
<header class="landing-hero">
  <div class="hero-badge">Apache 2.0 &middot; <a href="${GITHUB_REPO}" target="_blank" rel="noopener">tokencube/datazero</a></div>
  <h1>DataZero</h1>
  <p class="hero-subtitle">Robotics Data Flywheel Platform</p>
  <p class="hero-desc">Unified data collection, management, simulation, annotation, storage, and training for robotics — from CARLA fleet to Jetson deployment.</p>
  <a href="/datazero" class="hero-cta">Enter Studio</a>
</header>

<section class="capabilities">
  <h2>Capabilities</h2>
  <div class="cap-grid">
    <div class="cap-card">
      <div class="cap-icon">&#x1F3AC;</div>
      <h3>Collect</h3>
      <p>Multi-source MCAP ingestion — CARLA simulation, real mower hardware, MRO data pipelines.</p>
    </div>
    <div class="cap-card">
      <div class="cap-icon">&#x1F4E6;</div>
      <h3>Manage</h3>
      <p><strong>zdata</strong> format — MCAP + LanceDB + Label Studio / LeRobot / ShareGPT compatible. Apache 2.0.</p>
    </div>
    <div class="cap-card">
      <div class="cap-icon">&#x1F3AE;</div>
      <h3>Simulate</h3>
      <p>CARLA Town05 fleet with 5 mowers, RGB cameras, ROS2 bridge, Foxglove live visualization.</p>
    </div>
    <div class="cap-card">
      <div class="cap-icon">&#x1F3F7;</div>
      <h3>Annotate</h3>
      <p>Label Studio integration with active learning queue, PoA consensus, and auto-pre-annotation.</p>
    </div>
    <div class="cap-card">
      <div class="cap-icon">&#x1F9E0;</div>
      <h3>Train</h3>
      <p>QLoRA fine-tuning on 8&times;A100 SXM4 GPUs. VLA models from simulation to real deployment.</p>
    </div>
    <div class="cap-card">
      <div class="cap-icon">&#x1F680;</div>
      <h3>Deploy</h3>
      <p>Jetson Orin NX edge inference. OTA model updates. Cloud control with safety engage gate.</p>
    </div>
  </div>
</section>

<section class="format-section">
  <h2>zdata Format</h2>
  <p>The open robotics data format. MCAP container + LanceDB tables + Label Studio / LeRobot / ShareGPT exports.</p>
  <div class="format-links">
    <a href="${GITHUB_REPO}" target="_blank" rel="noopener" class="format-link">GitHub</a>
    <a href="/datazero" class="format-link alt">Studio</a>
  </div>
</section>

<footer class="landing-footer">
  <p>DataZero &middot; Part of the <a href="https://zmail.bot">Zero</a> ecosystem</p>
</footer>`;
}

export function renderLandingPage(): string {
  return renderShell({
    title: "DataZero — Robotics Data Flywheel Platform",
    description: "Unified robotics data platform — collect, manage, simulate, annotate, train, deploy.",
    body: renderLandingBody(),
    extraStyle: LANDING_CSS,
    lang: "en",
  });
}

const LANDING_CSS = `
:root {
  color-scheme: light;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: ${PALETTE.ink};
  background: ${PALETTE.bg};
  line-height: 1.6;
}

/* ── Hero ── */
.landing-hero {
  text-align: center;
  padding: clamp(4rem, 8vw, 7rem) 1.5rem clamp(3rem, 5vw, 5rem);
  max-width: 720px;
  margin: 0 auto;
}
.hero-badge {
  display: inline-block;
  font-size: 0.8rem;
  color: ${PALETTE.inkMuted};
  background: ${PALETTE.bgSurface};
  border: 1px solid ${PALETTE.border};
  border-radius: 999px;
  padding: 0.35rem 1rem;
  margin-bottom: 1.5rem;
}
.hero-badge a {
  color: ${PALETTE.accent};
  text-decoration: none;
}
.hero-badge a:hover { text-decoration: underline; }
.landing-hero h1 {
  font-size: clamp(2.8rem, 6vw, 4.5rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  margin: 0 0 0.5rem;
  color: ${PALETTE.ink};
}
.hero-subtitle {
  font-size: clamp(1.2rem, 2vw, 1.5rem);
  margin: 0 0 1rem;
  color: ${PALETTE.inkMuted};
  font-weight: 500;
}
.hero-desc {
  font-size: 1rem;
  color: ${PALETTE.inkFaint};
  max-width: 560px;
  margin: 0 auto 2rem;
  line-height: 1.65;
}
.hero-cta {
  display: inline-block;
  padding: 0.75rem 2.5rem;
  background: ${PALETTE.accent};
  color: #fff;
  border-radius: 8px;
  font-weight: 600;
  font-size: 1rem;
  text-decoration: none;
  transition: background 0.15s;
}
.hero-cta:hover { background: ${PALETTE.accentSoft}; }

/* ── Capabilities ── */
.capabilities {
  max-width: 1024px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}
.capabilities h2 {
  text-align: center;
  font-size: 1.6rem;
  font-weight: 600;
  margin-bottom: 2rem;
}
.cap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
}
.cap-card {
  background: ${PALETTE.bgSurface};
  border: 1px solid ${PALETTE.border};
  border-radius: 12px;
  padding: 1.5rem;
  transition: box-shadow 0.15s;
}
.cap-card:hover {
  box-shadow: ${PALETTE.shadowMd};
}
.cap-icon {
  font-size: 1.8rem;
  margin-bottom: 0.5rem;
}
.cap-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  font-weight: 600;
}
.cap-card p {
  margin: 0;
  font-size: 0.9rem;
  color: ${PALETTE.inkMuted};
  line-height: 1.55;
}

/* ── Format ── */
.format-section {
  max-width: 720px;
  margin: 0 auto 3rem;
  padding: 2rem 1.5rem;
  text-align: center;
  background: ${PALETTE.bgSurface};
  border: 1px solid ${PALETTE.border};
  border-radius: 12px;
}
.format-section h2 {
  margin: 0 0 0.5rem;
  font-size: 1.3rem;
}
.format-section p {
  margin: 0 0 1.25rem;
  color: ${PALETTE.inkMuted};
  font-size: 0.95rem;
}
.format-links {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
}
.format-link {
  display: inline-block;
  padding: 0.55rem 1.5rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.9rem;
  text-decoration: none;
  border: 1px solid ${PALETTE.border};
  color: ${PALETTE.ink};
  background: ${PALETTE.bg};
  transition: background 0.15s;
}
.format-link:hover { background: ${PALETTE.bgHover}; }
.format-link.alt {
  background: ${PALETTE.accent};
  color: #fff;
  border-color: ${PALETTE.accent};
}
.format-link.alt:hover { background: ${PALETTE.accentSoft}; }

/* ── Footer ── */
.landing-footer {
  text-align: center;
  padding: 2rem 1.5rem;
  font-size: 0.85rem;
  color: ${PALETTE.inkFaint};
  border-top: 1px solid ${PALETTE.border};
}
.landing-footer a {
  color: ${PALETTE.accent};
  text-decoration: none;
}
`;
