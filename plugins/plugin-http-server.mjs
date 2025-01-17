import graphQLOptions from '../utils/graphql-options.mjs';

export default function useHttpServer(env) {
    return {
        async onParams({params, request, setParams, setResult, fetchAPI}) {
            // if an HTTP GraphQL server is configured, pass the request to that
            if (env.USE_ORIGIN !== 'true') {
                return;
            }
            try {
                const serverUrl = `https://api.tarkov.dev${graphQLOptions.baseEndpoint}`;
                const queryResult = await fetch(serverUrl, {
                    method: request.method,
                    body: JSON.stringify(params),
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
                if (queryResult.status !== 200) {
                    throw new Error(`${queryResult.status} ${queryResult.statusText}: ${await queryResult.text()}`);
                }
                console.log('Request served from graphql server');
                setResult(await queryResult.json());
                request.cached = true;
            } catch (error) {
                console.error(`Error getting response from GraphQL server: ${error}`);
            }
        },
    }
}