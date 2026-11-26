import { gate } from "@/lib/gate";
import { MembersView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Members" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "members");
  return <MembersView />;
}
