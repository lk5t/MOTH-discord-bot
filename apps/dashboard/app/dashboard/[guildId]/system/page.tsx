import { gate } from "@/lib/gate";
import { SystemView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "System" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "system");
  return <SystemView />;
}
