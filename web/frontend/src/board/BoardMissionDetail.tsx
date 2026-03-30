import { useRoute } from "wouter";
import { BoardLayout } from "./BoardLayout";
import { MissionDetailContent } from "../components/missions/MissionDetailContent";

export function BoardMissionDetail() {
  const [, params] = useRoute("/mission/:slug/issue/:id");
  const slug = params?.slug ?? "";
  const id = params?.id ?? "";

  return (
    <BoardLayout title="Mission" slug={slug}>
      <MissionDetailContent
        id={id}
        onBack={() => window.history.back()}
        backLabel="Board"
      />
    </BoardLayout>
  );
}
