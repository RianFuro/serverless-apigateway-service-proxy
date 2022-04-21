'use strict'

const _ = require('lodash')
const { oneLineTrim } = require('common-tags')

module.exports = {
  compileMethodsToDynamodb() {
    this.validated.events.forEach((event) => {
      if (event.serviceName == 'dynamodb') {
        const resourceId = this.getResourceId(event.http.path)
        const resourceName = this.getResourceName(event.http.path)

        const template = {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: event.http.method.toUpperCase(),
            RequestParameters: {},
            AuthorizationType: event.http.auth.authorizationType,
            AuthorizationScopes: event.http.auth.authorizationScopes,
            AuthorizerId: event.http.auth.authorizerId,
            ApiKeyRequired: Boolean(event.http.private),
            ResourceId: resourceId,
            RestApiId: this.provider.getApiGatewayRestApiId()
          }
        }

        _.merge(
          template,
          this.getDynamodbMethodIntegration(event.http),
          this.getMethodResponses(event.http)
        )

        const methodLogicalId = this.provider.naming.getMethodLogicalId(
          resourceName,
          event.http.method
        )

        this.apiGatewayMethodLogicalIds.push(methodLogicalId)

        _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
          [methodLogicalId]: template
        })
      }
    })
  },

  getDynamodbMethodIntegration(http) {
    const integration = {
      IntegrationHttpMethod: 'POST',
      Type: 'AWS',
      Credentials: {
        'Fn::GetAtt': ['ApigatewayToDynamodbRole', 'Arn']
      },
      Uri: {
        'Fn::Sub': [
          'arn:${AWS::Partition}:apigateway:${AWS::Region}:dynamodb:action/${action}',
          { action: http.action }
        ]
      },
      PassthroughBehavior: 'NEVER',
      RequestTemplates: this.getDynamodbIntegrationRequestTemplates(http)
    }

    const integrationResponse = {
      IntegrationResponses: [
        {
          StatusCode: 200,
          SelectionPattern: '2\\d{2}',
          ResponseParameters: {},
          ResponseTemplates: this.getDefaultDynamodbResponseTemplates(http)
        },
        {
          StatusCode: 400,
          SelectionPattern: '4\\d{2}',
          ResponseParameters: {},
          ResponseTemplates: {}
        },
        {
          StatusCode: 500,
          SelectionPattern: '5\\d{2}',
          ResponseParameters: {},
          ResponseTemplates: {}
        }
      ]
    }

    this.addCors(http, integrationResponse)

    _.merge(integration, integrationResponse)

    return {
      Properties: {
        Integration: integration
      }
    }
  },

  getDynamodbIntegrationRequestTemplates(http) {
    const defaultRequestTemplates = this.buildDefaultDynamodbRequestTemplates(http)
    return Object.assign(defaultRequestTemplates, _.get(http, ['request', 'template']))
  },

  buildDefaultDynamodbRequestTemplates(http) {
    return {
      'application/json': this.buildDefaultDynamodbRequestTemplate(http),
      'application/x-www-form-urlencoded': this.buildDefaultDynamodbRequestTemplate(http)
    }
  },

  getDynamodbObjectHashkeyParameter(http) {
    return this.makeKeyDefinition(http.hashKey)
  },

  getDynamodbObjectRangekeyParameter(http) {
    return this.makeKeyDefinition(http.rangeKey)
  },

  makeKeyDefinition(keyParameter) {
    if (keyParameter.pathParam) {
      return {
        key: keyParameter.pathParam,
        attributeType: keyParameter.attributeType,
        attributeValue: `$input.params().path.${keyParameter.pathParam}`
      }
    }

    if (keyParameter.queryStringParam) {
      return {
        key: keyParameter.queryStringParam,
        attributeType: keyParameter.attributeType,
        attributeValue: `$input.params().querystring.${keyParameter.queryStringParam}`
      }
    }

    if (keyParameter.name && keyParameter.value) {
      return {
        key: keyParameter.name,
        attributeType: keyParameter.attributeType,
        attributeValue: keyParameter.value
      }
    }
  },

  getDefaultDynamodbResponseTemplates(http) {
    if (http.action === 'GetItem') {
      return {
        'application/json': this.getGetItemDefaultDynamodbResponseTemplate(),
        'application/x-www-form-urlencoded': this.getGetItemDefaultDynamodbResponseTemplate()
      }
    }

    return {}
  },

  getGetItemDefaultDynamodbResponseTemplate() {
    return oneLineTrim`
      #set($item = $input.path('$.Item')){#foreach($key in $item.keySet())
      #set ($value = $item.get($key))#foreach( $type in $value.keySet())"$key":"$util.escapeJavaScript($value.get($type)).replaceAll("\\\\'","'")"
      #if($foreach.hasNext()),#end#end#if($foreach.hasNext()),#end#end}
    `
  },

  buildDefaultDynamodbRequestTemplate(http) {
    switch (http.action) {
      case 'PutItem':
        return this.buildDefaultDynamodbPutItemRequestTemplate(http)
      case 'GetItem':
        return this.buildDefaultDynamodbGetItemRequestTemplate(http)
      case 'DeleteItem':
        return this.buildDefaultDynamodbDeleteItemRequestTemplate(http)
    }
  },

  buildDefaultDynamodbDeleteItemRequestTemplate(http) {
    const fuSubValues = {
      TableName: http.tableName
    }

    let requestTemplate = '{"TableName": "${TableName}","Key":{'
    if (_.has(http, 'hashKey')) {
      requestTemplate += '"${HashKey}": {"${HashAttributeType}": "${HashAttributeValue}"}'
      Object.assign(fuSubValues, this.getDynamodbHashkeyFnSubValues(http))
    }

    if (_.has(http, 'rangeKey')) {
      requestTemplate += ',"${RangeKey}": {"${RangeAttributeType}": "${RangeAttributeValue}"}'
      Object.assign(fuSubValues, this.getDynamodbRangekeyFnSubValues(http))
    }
    requestTemplate += '}'
    if (_.has(http, 'condition')) {
      requestTemplate += ',"ConditionExpression": "${ConditionExpression}"'
      fuSubValues['ConditionExpression'] = http.condition
    }
    requestTemplate += '}'
    return {
      'Fn::Sub': [`${requestTemplate}`, fuSubValues]
    }
  },

  buildDefaultDynamodbGetItemRequestTemplate(http) {
    const fuSubValues = {
      TableName: http.tableName
    }

    let requestTemplate = '{"TableName": "${TableName}","Key":{'
    if (_.has(http, 'hashKey')) {
      requestTemplate += '"${HashKey}": {"${HashAttributeType}": "${HashAttributeValue}"}'
      Object.assign(fuSubValues, this.getDynamodbHashkeyFnSubValues(http))
    }

    if (_.has(http, 'rangeKey')) {
      requestTemplate += ',"${RangeKey}": {"${RangeAttributeType}": "${RangeAttributeValue}"}'
      Object.assign(fuSubValues, this.getDynamodbRangekeyFnSubValues(http))
    }

    requestTemplate += '}}'
    return {
      'Fn::Sub': [`${requestTemplate}`, fuSubValues]
    }
  },

  buildDefaultDynamodbPutItemRequestTemplate(http) {
    const fuSubValues = {
      TableName: http.tableName
    }

    let requestTemplate = '{"TableName": "${TableName}","Item": {'
    if (_.has(http, 'hashKey')) {
      requestTemplate += '"${HashKey}": {"${HashAttributeType}": "${HashAttributeValue}"},'
      Object.assign(fuSubValues, this.getDynamodbHashkeyFnSubValues(http))
    }

    if (_.has(http, 'rangeKey')) {
      requestTemplate += '"${RangeKey}": {"${RangeAttributeType}": "${RangeAttributeValue}"},'
      Object.assign(fuSubValues, this.getDynamodbRangekeyFnSubValues(http))
    }

    requestTemplate += `
      #set ($body = $util.parseJson($input.body))
      #foreach( $key in $body.keySet())
        #set ($item = $body.get($key))
        #foreach( $type in $item.keySet())
          "$key":{"$type" : "$item.get($type)"}
        #if($foreach.hasNext()),#end
        #end
      #if($foreach.hasNext()),#end
      #end
    }
    `
    if (_.has(http, 'condition')) {
      requestTemplate += ',"ConditionExpression": "${ConditionExpression}"'
      fuSubValues['ConditionExpression'] = http.condition
    }

    requestTemplate += '}'
    return {
      'Fn::Sub': [`${requestTemplate}`, fuSubValues]
    }
  },

  getDynamodbHashkeyFnSubValues(http) {
    const objectHashKeyParam = this.getDynamodbObjectHashkeyParameter(http)
    return {
      HashKey: objectHashKeyParam.key,
      HashAttributeType: objectHashKeyParam.attributeType,
      HashAttributeValue: objectHashKeyParam.attributeValue
    }
  },

  getDynamodbRangekeyFnSubValues(http) {
    const objectRangeKeyParam = this.getDynamodbObjectRangekeyParameter(http)
    return {
      RangeKey: objectRangeKeyParam.key,
      RangeAttributeType: objectRangeKeyParam.attributeType,
      RangeAttributeValue: objectRangeKeyParam.attributeValue
    }
  }
}
