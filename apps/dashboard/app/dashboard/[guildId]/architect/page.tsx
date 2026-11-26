import { gate } from "@/lib/gate";
import { ArchitectView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Architect" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "architect");
  return <ArchitectView />;
}
