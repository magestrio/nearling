// The seam of the §4 events on the server. It writes nothing in `add-pet`: `add-analytics` puts
// the writing behind it. Routes call `track(name, props)`; a test replaces the sink to see the call.

export type TrackProps = Record<string, string | number | boolean>;
export type Sink = (name: string, props: TrackProps) => void;

const noop: Sink = () => {};
let sink: Sink = noop;

export function track(name: string, props: TrackProps = {}): void {
  sink(name, props);
}

/** Test seam: install a sink, get back the function that removes it. */
export function setTrackSink(next: Sink): () => void {
  sink = next;
  return () => {
    sink = noop;
  };
}
