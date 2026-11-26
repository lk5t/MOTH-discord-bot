import { gate } from "@/lib/gate";
import { AutomationView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "automation");
  return <AutomationView />;
}
