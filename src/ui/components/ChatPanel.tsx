import { QueenChat } from './QueenChat'

interface ChatPanelProps {
  roomId: number | null
  queenNickname: string | null
}

export function ChatPanel({ roomId, queenNickname }: ChatPanelProps): React.JSX.Element {
  return (
    <div className="p-4 flex flex-col min-h-full">
      <QueenChat roomId={roomId} queenNickname={queenNickname} />
    </div>
  )
}
