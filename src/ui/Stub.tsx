// An honest placeholder for a tab that is wired but not written yet.
//
// It says out loud that the screen is unbuilt and lists what is going to land
// on it. It deliberately does NOT mock up the real thing: a screen that looks
// finished and does nothing is worse than an empty one, on set and in review.
//
// DELETE THIS FILE (and the .stub rules in styles.css) once Home, Settings and
// Account are all real.

export function Stub(props: { title: string; lede: string; coming: string[] }) {
  return (
    <div className="stub">
      <span className="label">Not built yet</span>
      <h2 className="stub__h">{props.title}</h2>
      <p className="stub__p">{props.lede}</p>
      <ul className="stub__list">
        {props.coming.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
