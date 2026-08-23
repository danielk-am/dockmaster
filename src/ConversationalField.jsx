import { useId } from 'react';

export default function ConversationalField({ label, description, children, className = '' }) {
  const fieldId = useId();
  const labelId = `${fieldId}-label`;
  const descriptionId = `${fieldId}-description`;

  return (
    <div
      className={`ps-conversational-field${className ? ` ${className}` : ''}`}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
    >
      <div className="ps-conversational-field__prompt">
        <div id={labelId} className="ps-conversational-field__label">{label}</div>
        <p id={descriptionId}>{description}</p>
      </div>
      <div className="ps-conversational-field__control">{children}</div>
    </div>
  );
}
