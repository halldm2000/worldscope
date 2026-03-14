import { useEffect } from 'react'
import { useStore } from '@/store'
import { CesiumViewer } from '@/scene/CesiumViewer'
import { ChatPanel } from '@/ui/ChatPanel'
import { initAI } from '@/ai/init'

export function App() {
  const anthropicKey = useStore(s => s.anthropicKey)

  // Initialize AI system once
  useEffect(() => {
    initAI({ anthropicKey })
  }, [anthropicKey])

  return (
    <>
      <CesiumViewer />
      <ChatPanel />
    </>
  )
}
