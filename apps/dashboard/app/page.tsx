import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { MothMark } from "@/components/icons";

export const dynamic = "force-dynamic";

const FEATURES = [
  ["Architect", "Describe a server in plain language. MOTH designs roles, channels, permissions, onboarding and automations — with a full preview before anything changes."],
  ["Moderation", "Auto-moderation, escalating punishments, case management, appeals and explainable enforcement."],
  ["Security", "Join-spike detection, suspicious account scoring, raid mode, anti-nuke and one-click lockdown with exact restoration."],
  ["Tickets", "Multiple panels, private channels, claiming, priorities, forms and HTML transcripts."],
  ["Automation", "Visual workflow builder, schedules, reaction roles and AI-generated automations."],
  ["Community", "Levels, achievements, economy, giveaways, polls and analytics."],
];

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession().catch(() => null);
  if (session) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="landing">
      <div className="hero">
        <div className="row" style={{ justifyContent: "center", marginBottom: 28 }}>
          <span className="brand-mark" style={{ width: 56, height: 56, borderRadius: 16 }}><MothMark size={34} /></span>
        </div>
        <h1>Build Discord servers<br />with <em>intelligence.</em></h1>
        <p>MOTH is a self-hosted, AI-powered platform for designing, protecting and running Discord communities.</p>
        {error && <div className="chip crim" style={{ marginBottom: 18 }}>Sign-in failed ({error}). Please try again.</div>}
        <div className="row" style={{ justifyContent: "center" }}>
          <a className="btn primary" style={{ height: 46, padding: "0 26px", fontSize: 15 }} href="/api/auth/login">Sign in with Discord</a>
        </div>
        <div className="features">
          {FEATURES.map(([t, d]) => <div key={t} className="card flat"><h3 style={{ color: "var(--crimson)", marginBottom: 6 }}>{t}</h3><div className="muted small">{d}</div></div>)}
        </div>
      </div>
    </main>
  );
}
