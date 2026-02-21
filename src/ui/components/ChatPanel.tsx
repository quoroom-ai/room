import { QueenChat } from './QueenChat'

interface ChatPanelProps {
  roomId: number | null
}

export function ChatPanel({ roomId }: ChatPanelProps): React.JSX.Element {
  return (
    <div className="p-4 flex flex-col min-h-full">
      <QueenChat roomId={roomId} />
    </div>
  )
}
