import { gate } from "@/lib/gate";
import { TicketsView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "tickets");
  return <TicketsView />;
}
