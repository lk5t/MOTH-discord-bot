import { gate } from "@/lib/gate";
import { SecurityView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "security");
  return <SecurityView />;
}
