import { MothMark } from "@/components/icons";

export const metadata = { title: "Verification" };

export default async function Verified({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const ok = q.status === "ok";
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card" style={{ maxWidth: 440, width: "100%", textAlign: "center", padding: 32 }}>
        <span className="brand-mark" style={{ display: "inline-grid", margin: "0 auto 16px" }}><MothMark /></span>
        <h1 style={{ margin: "0 0 8px", fontSize: 24 }}>{ok ? "You're verified ✅" : "Verification failed"}</h1>
        <p className="muted" style={{ margin: 0 }}>{ok ? `${q.name ? `Welcome, ${q.name}! ` : ""}You can close this tab and head back to Discord — the server's channels are unlocked.` : q.message ?? "Something went wrong."}</p>
        {ok && <p className="small faint" style={{ marginTop: 16 }}>If this server is ever lost, staff can bring you back to its replacement automatically. You can remove this at any time in Discord → User Settings → Authorized Apps.</p>}
      </div>
    </main>
  );
}
