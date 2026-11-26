import { gate } from "@/lib/gate";
import { CommandsView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commands" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "commands");
  return <CommandsView />;
}
