import { gate } from "@/lib/gate";
import { AiView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Settings" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "ai");
  return <AiView />;
}
