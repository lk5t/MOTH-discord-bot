import { gate } from "@/lib/gate";
import { OverviewView } from "./overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "overview");
  return <OverviewView />;
}
