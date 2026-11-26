import { gate } from "@/lib/gate";
import { AnalyticsView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "analytics");
  return <AnalyticsView />;
}
