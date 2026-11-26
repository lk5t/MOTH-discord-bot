import { gate } from "@/lib/gate";
import { ModerationView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moderation" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "moderation");
  return <ModerationView />;
}
