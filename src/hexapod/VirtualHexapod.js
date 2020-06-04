import { identity } from "mathjs"
import Linkage from "./Linkage"
import * as oSolver1 from "./solvers/orientSolverSpecific"
import { simpleTwist, mightTwist, complexTwist } from "./solvers/twistSolver"
import Hexagon from "./Hexagon"
import { POSITION_NAMES_LIST } from "./constants"
import { matrixToAlignVectorAtoB, tRotZmatrix } from "./geometry"
import Vector from "./Vector"
import { DEFAULT_POSE } from "../templates"

const WORLD_AXES = {
    xAxis: new Vector(1, 0, 0, "worldXaxis"),
    yAxis: new Vector(0, 1, 0, "worldYaxis"),
    zAxis: new Vector(0, 0, 1, "worldZaxis"),
}

const computeLocalAxes = transformMatrix => ({
    xAxis: WORLD_AXES.xAxis.newTrot(transformMatrix, "hexapodXaxis"),
    yAxis: WORLD_AXES.yAxis.newTrot(transformMatrix, "hexapodYaxis"),
    zAxis: WORLD_AXES.zAxis.newTrot(transformMatrix, "hexapodZaxis"),
})

const transformLocalAxes = (localAxes, twistMatrix) => ({
    xAxis: localAxes.xAxis.cloneTrot(twistMatrix),
    yAxis: localAxes.yAxis.cloneTrot(twistMatrix),
    zAxis: localAxes.zAxis.cloneTrot(twistMatrix),
})

const buildLegsList = (verticesList, pose, legDimensions) =>
    POSITION_NAMES_LIST.map(
        (position, index) =>
            new Linkage(legDimensions, position, verticesList[index], pose[position])
    )

/* * *

............................
 Virtual Hexapod properties
............................

Property types:
{}: hash / object / dictionary
[]: array / list
##: number
"": string

{} this.dimensions: {front, side, middle, coxia, femur, tibia}

{} this.pose: A hash mapping the position name to a hash of three angles
    which define the pose of the hexapod
    i.e. { rightMiddle: {alpha, beta, gamma },
           leftBack: { alpha, betam gamma },
             ...
         }

[] this.body: A hexagon object
    which contains all the info of the 8 points defining the hexapod body
    (6 vertices, 1 head, 1 center of gravity)

[] this.legs: A list whose elemens point to six Linkage objects.
    One linkage object for each leg,
    the first element is the rightMiddle leg and the last
    element is rightBack leg.
    Each leg contains the points that define that leg
    as well as other properties pertaining it (see Linkage class)


{} this.localAxes: A hash containing three vectors defining the local
    coordinate frame of the hexapod wrt the world coordinate frame
    i.e. {
        xAxis: {x, y, z, name="hexapodXaxis", id="no-id"},
        yAxis: {x, y, z, name="hexapodYaxis", id="no-id"},
        zAxis: {x, y, z, name="hexapodZaxis", id="no-id"},
    }

[] this.groundContactPoints: a list whose elements point to points
    from the leg which contacts the ground.
    This list can contain 6 or less elements.
    (It can have a length of 3, 4, 5 or 6)
    i.e. [
        { x, y, z, name="rightMiddle-femurPoint", id="0-2"},
        { x, y, z, name="leftBack-footTipPoint", id=4-3},
         ...
    ]

## this.twistAngle: the angle the hexapod twist about its own z axis

....................
(virtual hexapod derived properties)
....................

## this.distanceFromGround: A number which is the perpendicular distance
    from the hexapod's center of gravity to the ground plane

{} this.cogProjection: a point that represents the projection
    of the hexapod's center of gravity point to the ground plane
    i.e { x, y, z, name="centerOfGravityProjectionPoint", id="no-id"}

{} this.bodyDimensions: { front, side, middle }
{} this.legDimensions: { coxia, femur, tibia }

 * * */
class VirtualHexapod {
    dimensions
    pose
    twistAngle
    legs
    body
    localAxes
    constructor(
        dimensions,
        pose,
        flags = { noGravity: false, shiftedUp: false, hasNoPoints: false }
    ) {
        Object.assign(this, { dimensions, pose, twistAngle: 0 })

        if (flags.hasNoPoints) {
            return
        }

        const flatHexagon = new Hexagon(this.bodyDimensions)
        // prettier-ignore
        const legsNoGravity = buildLegsList(
            flatHexagon.verticesList, this.pose, this.legDimensions
        )

        if (flags.noGravity) {
            this._danglingHexapod(flatHexagon, legsNoGravity, flags.shiftedUp)
            return
        }
        // .................
        // STEP 1: Find new orientation of the body (new normal / nAxis).
        // .................
        const solved = oSolver1.computeOrientationProperties(legsNoGravity)

        if (solved === null) {
            //unstable pose
            this._danglingHexapod(flatHexagon, legsNoGravity, flags.shiftedUp)
            return
        }

        // .................
        // STEP 2: Rotate and shift legs and body to this orientation
        // .................
        const transformMatrix = matrixToAlignVectorAtoB(solved.nAxis, WORLD_AXES.zAxis)

        this.legs = legsNoGravity.map(leg =>
            leg.cloneTrotShift(transformMatrix, 0, 0, solved.height)
        )
        this.body = flatHexagon.cloneTrotShift(transformMatrix, 0, 0, solved.height)
        this.localAxes = computeLocalAxes(transformMatrix)

        this.groundContactPoints = solved.groundLegsNoGravity.map(leg =>
            // prettier-ignore
            leg.maybeGroundContactPoint.cloneTrotShift(
                transformMatrix, 0, 0, solved.height
            )
        )

        if (this.legs.every(leg => leg.pose.alpha === 0)) {
            // hexapod will not twist about z axis
            return
        }

        // .................
        // STEP 3: Twist around the zAxis if you have to
        // .................
        this.twistAngle = simpleTwist(solved.groundLegsNoGravity)
        if (this.twistAngle !== 0) {
            this._twist()
        }

        if (mightTwist(solved.groundLegsNoGravity)) {
            const oldPoints = buildLegsList(
                flatHexagon.verticesList,
                DEFAULT_POSE,
                this.legDimensions
            ).map(leg => leg.maybeGroundContactPoint)

            const newPoints = solved.groundLegsNoGravity.map(
                leg => leg.maybeGroundContactPoint
            )

            this.twistAngle = complexTwist(oldPoints, newPoints)
            this._twist()
        }
    }

    get distanceFromGround() {
        return this.body.cog.z
    }

    get cogProjection() {
        return new Vector(
            this.body.cog.x,
            this.body.cog.y,
            0,
            "centerOfGravityProjectionPoint"
        )
    }

    get hasTwisted() {
        return this.twistAngle !== 0
    }

    get bodyDimensions() {
        const { front, middle, side } = this.dimensions
        return { front, middle, side }
    }

    get legDimensions() {
        const { coxia, femur, tibia } = this.dimensions
        return { coxia, femur, tibia }
    }

    cloneTrot(transformMatrix) {
        let clone = new VirtualHexapod(this.dimensions, this.pose, { hasNoPoints: true })
        clone.body = this.body.cloneTrot(transformMatrix)
        clone.legs = this.legs.map(leg => leg.cloneTrot(transformMatrix))
        clone.groundContactPoints = this.groundContactPoints.map(point =>
            point.cloneTrot(transformMatrix)
        )

        // Note: Assumes that the transform matrix is a rotation transform only
        clone.localAxes = transformLocalAxes(this.localAxes, transformMatrix)
        return clone
    }

    cloneShift(tx, ty, tz) {
        let clone = new VirtualHexapod(this.dimensions, this.pose, { hasNoPoints: true })
        clone.body = this.body.cloneShift(tx, ty, tz)
        clone.legs = this.legs.map(leg => leg.cloneShift(tx, ty, tz))
        clone.groundContactPoints = this.groundContactPoints.map(point =>
            point.cloneShift(tx, ty, tz)
        )
        clone.localAxes = this.localAxes
        return clone
    }

    _twist() {
        const twistMatrix = tRotZmatrix(this.twistAngle)
        this.legs = this.legs.map(leg => leg.cloneTrot(twistMatrix))
        this.body = this.body.cloneTrot(twistMatrix)
        this.groundContactPoints = this.groundContactPoints.map(point =>
            point.cloneTrot(twistMatrix)
        )

        this.localAxes = transformLocalAxes(this.localAxes, twistMatrix)
    }

    _danglingHexapod(body, legs, shiftedUp) {
        const transformMatrix = identity(4)
        this.localAxes = computeLocalAxes(transformMatrix)
        this.groundContactPoints = []

        if (!shiftedUp) {
            ;[this.body, this.legs] = [body, legs]
            return
        }

        const height = Object.values(this.legDimensions).reduce(
            (height, dim) => height + dim,
            0
        )
        this.body = body.cloneTrotShift(identity(4), 0, 0, height)
        this.legs = legs.map(leg => leg.cloneTrotShift(identity(4), 0, 0, height))
    }
}

export { computeLocalAxes }
export default VirtualHexapod
