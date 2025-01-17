/*import cacheMachine from './utils/cache-machine.mjs';
import getYoga from './graphql-yoga.mjs';
import graphQLOptions from './utils/graphql-options.mjs';

export default {
	async fetch(request, env, ctx) {
        try {
            const yoga = await getYoga({...env, RESPONSE_CACHE: cacheMachine});
            return yoga.fetch(request, {...env, ctx, RESPONSE_CACHE: cacheMachine});
        } catch (err) {
            console.log(err);
            return new Response(graphQLOptions.debug ? err : 'Something went wrong', { status: 500 });
        }
	},
};*/
import { graphql } from 'graphql';
import { v4 as uuidv4 } from 'uuid';

import DataSource from './datasources/index.mjs';
//import playground from './handlers/playground.mjs';
import graphiql from './handlers/graphiql.mjs';
import setCors from './utils/setCors.mjs';
import schema from './schema.mjs';
import graphqlUtil from './utils/graphql-util.mjs';
import graphQLOptions from './utils/graphql-options.mjs';
import cacheMachine from './utils/cache-machine.mjs';

import { getNightbotResponse } from './plugins/plugin-nightbot.mjs';
import { getTwitchResponse } from './plugins/plugin-twitch.mjs';

let dataAPI;

async function graphqlHandler(request, env, ctx) {
    const url = new URL(request.url);
    let query = false;
    let variables = false;

    if (request.method === 'POST') {
        try {
            const requestBody = await request.json();
            query = requestBody.query;
            variables = requestBody.variables;
        } catch (jsonError) {
            console.error(jsonError);

            return new Response(null, {
                status: 400,
            });
        }
    } else if (request.method === 'GET') {
        query = url.searchParams.get('query');
        variables = url.searchParams.get('variables');
    } 

    // Check for empty /graphql query
    if (!query || query.trim() === '') {
        return new Response('GraphQL requires a query in the body of the request',
            {
                status: 400,
                headers: { 'cache-control': 'public, max-age=2592000' }
            }
        );
    }

    // default headers
    const responseOptions = {
        headers: {
            'content-type': 'application/json;charset=UTF-8',
        }
    };

    if (!dataAPI) {
        dataAPI = new DataSource(env);
    }

    const requestId = uuidv4();
    console.info(requestId);
    console.log(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
    console.log(`KVs pre-loaded: ${dataAPI.kvLoaded.join(', ') || 'none'}`);
    //console.log(query);
    if (request.headers.has('x-newrelic-synthetics')) {
        console.log('NewRelic health check');
        //return new Response(JSON.stringify({}), responseOptions);
    }

    let specialCache = '';
    const contentType = request.headers.get('content-type');
    if (!contentType || !contentType.startsWith('application/json')) {
        specialCache = 'application/json';
    }

    let key;
    // Check the cache service for data first - If cached data exists, return it
    // we don't check the cache if we're the http server because the worker already did
    if (env.SKIP_CACHE !== 'true' && !env.CLOUDFLARE_TOKEN) {
        key = await cacheMachine.createKey(env, query, variables, specialCache);
        const cachedResponse = await cacheMachine.get(env, {key});
        if (cachedResponse) {
            // Construct a new response with the cached data
            const newResponse = new Response(cachedResponse, responseOptions);
            // Add a custom 'X-CACHE: HIT' header so we know the request hit the cache
            newResponse.headers.append('X-CACHE', 'HIT');
            console.log('Request served from cache');
            // Return the new cached response
            return newResponse;
        }
    } else {
        //console.log(`Skipping cache in ${ENVIRONMENT} environment`);
    }

    // if an HTTP GraphQL server is configured, pass the request to that
    if (env.USE_ORIGIN === 'true') {
        try {
            const serverUrl = `https://api.tarkov.dev${graphQLOptions.baseEndpoint}`;
            const queryResult = await fetch(serverUrl, {
                method: request.method,
                body: JSON.stringify({
                    query,
                    variables,
                }),
                headers: {
                    'Content-Type': 'application/json',
                    'cache-check-complete': 'true',
                },
            });
            if (queryResult.status !== 200) {
                throw new Error(`${queryResult.status} ${await queryResult.text()}`);
            }
            console.log('Request served from graphql server');
            return new Response(await queryResult.text(), responseOptions);
        } catch (error) {
            console.error(`Error getting response from GraphQL server: ${error}`);
        }
    }

    const context = graphqlUtil.getDefaultContext(dataAPI, requestId);
    let result, ttl;
    try {
        result = await graphql({schema: await schema(dataAPI, context), source: query, rootValue: {}, contextValue: context, variableValues: variables});
        ttl = dataAPI.getRequestTtl(requestId);
        //console.log(`${requestId} kvs loaded: ${dataAPI.requests[requestId].kvLoaded.join(', ')}`);
    } catch (error) {
        throw error;
    } finally {
        dataAPI.clearRequestData(requestId);
    }
    console.log('generated graphql response');
    if (context.errors.length > 0) {
        if (!result.errors) {
            result = Object.assign({errors: []}, result); // this puts the errors at the start of the result
        }
        result.errors.push(...context.errors);
    }
    if (context.warnings.length > 0) {
        if (!result.warnings) {
            result = Object.assign({warnings: []}, result);
        }
        result.warnings.push(...context.warnings);
    }

    if (specialCache === 'application/json') {
        if (!result.warnings) {
            result = Object.assign({warnings: []}, result);
        }
        ttl = 30 * 60;
        result.warnings.push({message: `Your request does not have a "content-type" header set to "application/json". Requests missing this header are limited to resposnes that update every ${ttl/60} minutes.`});
    } else if (ttl > 1800) {
        // if the ttl is greater than a half hour, limit it
        ttl = 1800;
    }

    const body = JSON.stringify(result);

    const response = new Response(body, responseOptions);

    if (env.SKIP_CACHE !== 'true' && ttl > 0) {
        // using waitUntil doesn't hold up returning a response but keeps the worker alive as long as needed
        ctx.waitUntil(cacheMachine.put(env, body, {key, query, variables, ttl, specialCache}));
    }

    return response;
}

export default {
	async fetch(request, env, ctx) {
        if (!graphQLOptions.cors.allowMethods.split(', ').includes(request.method.toUpperCase())) {
            const errorResponse = new Response(null, {
                status: 405,
                headers: { 'cache-control': 'public, max-age=2592000' },
            });
            setCors(errorResponse, graphQLOptions.cors);
            return errorResponse;
        }
        if (request.method.toUpperCase() === 'OPTIONS') {
            const optionsResponse = new Response(null, {
                headers: { 'cache-control': 'public, max-age=2592000' },
            });
            setCors(optionsResponse, graphQLOptions.cors);
            return optionsResponse;
        }
        const requestStart = new Date();
		const url = new URL(request.url);

        let response;

        try {
            if (url.pathname === '/twitch') {
                response = await getTwitchResponse(env);
                if (graphQLOptions.cors) {
                    setCors(response, graphQLOptions.cors);
                }
            }

            if (url.pathname === graphQLOptions.playgroundEndpoint) {
                //response = playground(request, graphQLOptions);
                response = graphiql(graphQLOptions);
            }

            if (graphQLOptions.forwardUnmatchedRequestsToOrigin) {
                return fetch(request);
            }
            
            if (url.pathname === '/webhook/nightbot' ||
                url.pathname === '/webhook/stream-elements' ||
                url.pathname === '/webhook/moobot'
            ) {
                response = await getNightbotResponse(request, url, env, ctx);
            }

            if (url.pathname === graphQLOptions.baseEndpoint) {
                response = await graphqlHandler(request, env, ctx);
                if (graphQLOptions.cors) {
                    setCors(response, graphQLOptions.cors);
                }
            }

            if (!response) {
                response = new Response('Not found', { status: 404 });
            }
            console.log(`Response time: ${new Date() - requestStart} ms`);
			return response;
        } catch (err) {
            console.log(err);
            return new Response(graphQLOptions.debug ? err : 'Something went wrong', { status: 500 });
        }
	},
};
