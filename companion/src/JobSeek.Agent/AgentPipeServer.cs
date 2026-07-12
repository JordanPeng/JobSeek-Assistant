using System.IO.Pipes;
using System.Text;
using JobSeek.Protocol;
using JobSeek.Protocol.IO;

namespace JobSeek.Agent;

internal sealed class AgentPipeServer
{
    public const int MaximumMessageBytes = 524288;

    private readonly string pipeName;
    private readonly Action<string> log;
    private readonly AgentDispatcher dispatcher;

    public AgentPipeServer(string pipeName, Action<string> log, AgentDispatcher dispatcher)
    {
        this.pipeName = pipeName;
        this.log = log;
        this.dispatcher = dispatcher;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            using var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                await ServeOneAsync(server, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (ProtocolException)
            {
                log("pipe protocol_error");
            }
            catch (IOException)
            {
                log("pipe io_error");
            }
        }
    }

    private async Task ServeOneAsync(Stream stream, CancellationToken cancellationToken)
    {
        var frame = await LengthPrefixedJson.ReadAsync(stream, MaximumMessageBytes, cancellationToken).ConfigureAwait(false);
        var response = dispatcher.Dispatch(LengthPrefixedJson.DecodeUtf8(frame));
        await LengthPrefixedJson.WriteTextAsync(stream, response, MaximumMessageBytes, cancellationToken).ConfigureAwait(false);
        log("pipe request_completed");
    }
}
