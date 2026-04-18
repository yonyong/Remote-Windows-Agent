export function throwWithLlmModelOutput(message, modelOutput, cause) {
    const e = new Error(message);
    e.llmModelOutput = modelOutput;
    if (cause !== undefined)
        e.cause = cause;
    throw e;
}
export function throwWithLlmHttpBody(message, httpBody) {
    const e = new Error(message);
    e.llmHttpBody = httpBody;
    throw e;
}
