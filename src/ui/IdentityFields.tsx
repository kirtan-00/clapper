// THE TWO INPUTS, shared. SignInSheet.tsx and Onboarding.tsx's SignInStage
// both ask "your name" / "production house" immediately above their own
// Google button, and both need to look like the same question asked twice
// rather than two different forms - so this is the one place that renders
// them. Presentation only: it holds no state and knows nothing about
// getStudio/setStudio. Each caller owns its own name/studio state (it was
// already reading getStudio() to prefill before this file existed) and
// decides for itself when to persist - see saveIdentityBeforeGoogle in
// studio.ts for that rule, which is the part that actually had to be
// singular.
//
// Same classes StudioSheet.tsx originated (`.formrow`, `.label`, `.field`),
// so a third surface asking this question still reads as the same form.

export function IdentityFields(props: {
  /** Keeps element ids unique per call site; the two sheets never render at
   *  once today, but there is no reason to rely on that. */
  idPrefix: string;
  name: string;
  studioName: string;
  onNameChange: (v: string) => void;
  onStudioChange: (v: string) => void;
}) {
  return (
    <>
      <div className="formrow">
        <label className="label" htmlFor={`${props.idPrefix}-name`}>
          Your name
        </label>
        <input
          id={`${props.idPrefix}-name`}
          className="field"
          autoComplete="name"
          placeholder="e.g. Kirtan"
          value={props.name}
          onChange={(e) => props.onNameChange(e.target.value)}
        />
      </div>

      <div className="formrow">
        <label className="label" htmlFor={`${props.idPrefix}-house`}>
          Production house
        </label>
        <input
          id={`${props.idPrefix}-house`}
          className="field"
          autoComplete="organization"
          placeholder="e.g. Fourside Studio"
          value={props.studioName}
          onChange={(e) => props.onStudioChange(e.target.value)}
        />
      </div>
    </>
  );
}
