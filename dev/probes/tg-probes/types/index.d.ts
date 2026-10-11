export type ProbeView = 'all' | 'p2' | 'p4hex' | 'p4theme' | 'p4fill' | 'p6' | 'p6unknown' | 'p6status'

declare module 'claude-code' {
  interface PluginState {
    'tg-probes': { view: ProbeView; card: boolean; presses: string[]; cardRow: number }
  }
}
