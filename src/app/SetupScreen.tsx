/**
 * SetupScreen - Legacy setup screen, kept for reference.
 * The app now launches directly with an embedded Cesium Ion token.
 * Users can override tokens via the "set cesium token" or "set key" commands.
 */

import { useStore } from '@/store'
import styles from './SetupScreen.module.css'

export function SetupScreen() {
  const setCesiumToken = useStore(s => s.setCesiumToken)

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Worldscope</h1>
        <p className={styles.subtitle}>
          The app should launch automatically. If you see this screen,
          use the command bar to set your Cesium Ion token:
          "set cesium token eyJ..."
        </p>
        <button className={styles.btnPrimary} onClick={() => setCesiumToken(useStore.getState().cesiumToken)}>
          Launch with Default Token
        </button>
      </div>
    </div>
  )
}
