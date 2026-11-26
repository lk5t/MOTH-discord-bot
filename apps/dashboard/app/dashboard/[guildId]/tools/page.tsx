import { gate } from "@/lib/gate";
import { ToolsView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Server Tools" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "tools");
  return <ToolsView />;
}
